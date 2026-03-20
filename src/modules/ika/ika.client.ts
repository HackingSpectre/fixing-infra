/**
 * @module ika/ika.client
 *
 * IKA SDK client lifecycle — singleton initialisation, RPC failover,
 * and teardown.
 *
 * All error classification, encryption-key resilience, and RPC
 * resolution logic has been extracted into dedicated modules.  This
 * module wires them together and owns the **one mutable concern**:
 * the lazily-initialised `IkaClientContext` singleton.
 *
 * Backward-compatible re-exports are provided at the bottom so that
 * existing test imports (`from "./ika.client"`) continue to work
 * without modification.
 */

import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { getErrorMessage, isTransientNetworkFetchError, extractErrorChain } from "./errors";
import { getRpcCandidates } from "./rpc";
import { readFromDiskCache, writeToDiskCache } from "./disk-cache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IkaClientContext {
  ikaClient: any;
  suiClient: any;
  rpcUrl: string;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let contextPromise: Promise<IkaClientContext> | null = null;
let lastSuccessfulRpcIndex: number | null = null;

/** How many times to attempt `ikaClient.initialize()` per RPC endpoint. */
const INIT_ATTEMPTS_PER_RPC = 2;

/** Delay between init retries on the *same* RPC endpoint. */
const INIT_RETRY_DELAY_MS = 10_000;

// ---------------------------------------------------------------------------
// Lifecycle — public API
// ---------------------------------------------------------------------------

/** Discard the cached client promise so the next call re-initialises. */
export function resetIkaClientContext(): void {
  contextPromise = null;
}

/**
 * Return a ready-to-use `IkaClientContext`, lazily initialising one if
 * needed.  On transient failures the function walks through the
 * priority-sorted RPC candidate list, retrying each endpoint up to
 * `INIT_ATTEMPTS_PER_RPC` times.
 */
export async function getInitializedIkaClientContext(options?: {
  forceRefresh?: boolean;
  rotateRpcCandidate?: boolean;
}): Promise<IkaClientContext> {
  if (options?.forceRefresh) {
    contextPromise = null;
  }

  if (contextPromise) {
    return contextPromise;
  }

  contextPromise = (async () => {
    const sdk = (await import("@ika.xyz/sdk")) as Record<string, any>;
    const suiClientModule = (await import("@mysten/sui/jsonRpc")) as Record<string, any>;

    const IkaClient = sdk.IkaClient as new (args: Record<string, unknown>) => any;
    const getNetworkConfig = sdk.getNetworkConfig as (network: "testnet" | "mainnet") => unknown;
    const SuiJsonRpcClient = suiClientModule.SuiJsonRpcClient as new (args: { url: string; network: string }) => any;

    const rpcCandidates = getRpcCandidates();
    const startIndex =
      options?.rotateRpcCandidate && lastSuccessfulRpcIndex !== null
        ? (lastSuccessfulRpcIndex + 1) % rpcCandidates.length
        : 0;

    let lastError: unknown;

    for (let offset = 0; offset < rpcCandidates.length; offset += 1) {
      const index = (startIndex + offset) % rpcCandidates.length;
      const rpcUrl = rpcCandidates[index];

      for (let initAttempt = 1; initAttempt <= INIT_ATTEMPTS_PER_RPC; initAttempt += 1) {
        try {
          const suiClient = new SuiJsonRpcClient({
            url: rpcUrl,
            network: env.IKA_NETWORK,
          });

          const ikaClient = new IkaClient({
            suiClient,
            config: getNetworkConfig(env.IKA_NETWORK),
            cache: true,
            encryptionKeyOptions: { autoDetect: true },
          });

          await ikaClient.initialize();
          lastSuccessfulRpcIndex = index;

          logger.info("ika_client_initialized", {
            rpcUrl,
            network: env.IKA_NETWORK,
          });

          return { ikaClient, suiClient, rpcUrl };
        } catch (error) {
          lastError = error;
          logger.warn("ika_client_init_failed", {
            rpcUrl,
            network: env.IKA_NETWORK,
            initAttempt,
            error: error instanceof Error ? error.message : String(error),
            errorChain: extractErrorChain(error),
          });

          if (isTransientNetworkFetchError(error) && initAttempt < INIT_ATTEMPTS_PER_RPC) {
            await sleep(INIT_RETRY_DELAY_MS);
            continue;
          }

          break;
        }
      }
    }

    contextPromise = null;
    throw new Error(
      `Failed to initialize IKA client on all RPC candidates. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  })();

  return contextPromise;
}

// ---------------------------------------------------------------------------
// SDK cache warm-up
// ---------------------------------------------------------------------------

/**
 * Pre-populate the SDK's internal caches with encryption keys and protocol
 * public parameters for SECP256K1.
 *
 * Why this matters (SDK 0.3.1 bug workaround):
 *   • `getProtocolPublicParameters()` calls `fetchEncryptionKeysFromNetwork()`
 *     directly — a private method that **always hits the network**, bypassing
 *     the dedup-promise guard in `fetchEncryptionKeys()`.  Each call makes
 *     5–10 sequential RPC requests (listDynamicFields + getObject × N).
 *   • Without warm-up, the first DKG flow can make many RPC calls,
 *     triggering Sui testnet 429 rate-limits.
 *   • With warm-up: encryption keys + protocol params for the active curve are
 *     cached.  The DKG adapter calls `getCachedProtocolPublicParameters()`
 *     first and only falls back to the network on a true cache miss.
 *   • We add a delay before protocol params fetch to avoid bursting the RPC
 *     during warm-up itself.
 */
export async function warmUpSdkCaches(ikaClient: any): Promise<void> {
  try {
    // Step 0: Try reading all encryption keys from disk cache first
    const diskKeys = await readFromDiskCache("latest-encryption-keys.json");
    let keys: any[] | null = null;
    let cacheHit = false;

    if (diskKeys && Array.isArray(diskKeys) && diskKeys.length > 0) {
       logger.info("ika_cache_warmup_keys_from_disk_cache", { keyCount: diskKeys.length });
       if (typeof ikaClient.setNetworkEncryptionKeysInCache === "function") {
         ikaClient.setNetworkEncryptionKeysInCache(diskKeys);
       }
       keys = diskKeys;
       cacheHit = true;
    }

    // Step 1: Fetch and cache all encryption keys via the cache-respecting path if disk cache failed
    if (!cacheHit) {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        try {
          keys = await ikaClient.getAllNetworkEncryptionKeys();
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const is429 = msg.includes("429") || msg.includes("Too Many Requests");
          logger.warn("ika_cache_warmup_encryption_keys_attempt_failed", {
            attempt,
            is429,
            error: msg,
            errorChain: extractErrorChain(err),
          });
          if (attempt === 10 || !is429) throw err;
          // Increasing backoff: 4s, 8s
          await sleep(4_000 * attempt);
          // Clear the SDK's failed promise so the next call retries
          if (typeof ikaClient.invalidateEncryptionKeyCache === "function") {
            ikaClient.invalidateEncryptionKeyCache();
          }
        }
      }
    }

    if (!cacheHit && keys && keys.length > 0) {
      await writeToDiskCache("latest-encryption-keys.json", keys);
    }

    const keyCount = Array.isArray(keys) ? keys.length : 0;
    logger.info("ika_cache_warmup_encryption_keys_done", { keyCount });

    // Step 2: Pre-fetch protocol public parameters for SECP256K1.
    // First check disk cache — if we already saved params from a previous
    // successful run, load them directly into the SDK's memory cache and
    // skip the network entirely.
    const sdk = (await import("@ika.xyz/sdk")) as Record<string, any>;
    const Curve = sdk.Curve;

    if (Curve && keys && keys.length > 0) {
      const latestKey = keys[keys.length - 1];
      const encryptionKeyId: string = latestKey.id;
      const curves = [Curve.SECP256K1].filter(Boolean);

      for (let i = 0; i < curves.length; i += 1) {
        const curve = curves[i];
        const curveString = String(curve);
        const diskFilename = `protocol-params-${encryptionKeyId}-${curveString}.json`;

        try {
          // Try disk cache first
          const diskParams = await readFromDiskCache(diskFilename);
          if (diskParams && diskParams instanceof Uint8Array) {
            logger.info("ika_cache_warmup_protocol_params_from_disk", { curve: curveString, encryptionKeyId });

            // Inject into SDK memory cache so getCachedProtocolPublicParameters() returns instantly
            if (typeof ikaClient.setCachedProtocolPublicParameters === "function") {
              ikaClient.setCachedProtocolPublicParameters(encryptionKeyId, curve, diskParams);
            }
            continue; // Skip network fetch for this curve
          }

          // Disk cache miss — fetch from network with retries and save to disk.
          // This only happens once ever (first run). After that, disk cache takes over.
          let params: any = null;
          for (let pAttempt = 1; pAttempt <= 5; pAttempt++) {
            try {
              // Backoff: 429 rate-limits get longer cooldowns, timeouts get shorter ones
              const fetchIs429Previous = pAttempt > 1; // only relevant after first failure
              const preDelay = pAttempt === 1 ? 3_000 : (fetchIs429Previous ? 10_000 * pAttempt : 5_000 * pAttempt);
              await sleep(preDelay);
              logger.info("ika_cache_warmup_protocol_params_fetching", { curve: curveString, attempt: pAttempt });
              params = await ikaClient.getProtocolPublicParameters(undefined, curve);
              break;
            } catch (fetchErr) {
              const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
              const fetchIs429 = fetchMsg.includes("429") || fetchMsg.includes("Too Many Requests");
              const isTransient = isTransientNetworkFetchError(fetchErr);
              logger.warn("ika_cache_warmup_protocol_params_attempt_failed", {
                curve: curveString, attempt: pAttempt, is429: fetchIs429, isTransient, error: fetchMsg,
                errorChain: extractErrorChain(fetchErr),
              });
              // Retry on ANY transient error (timeouts, connection resets, 429s)
              // Only give up on non-transient errors or after all attempts exhausted
              if (pAttempt === 5 || !isTransient) throw fetchErr;
            }
          }

          if (params) {
            logger.info("ika_cache_warmup_protocol_params_done", { curve: curveString });

            // Persist to disk so future restarts skip the network entirely
            await writeToDiskCache(diskFilename, params);
            logger.info("ika_cache_warmup_protocol_params_saved_to_disk", { curve: curveString, encryptionKeyId });
          }
        } catch (err) {
          // Non-fatal — the DKG adapter has its own cache-first + fallback logic.
          logger.warn("ika_cache_warmup_protocol_params_failed", {
            curve: curveString,
            error: err instanceof Error ? err.message : String(err),
            errorChain: extractErrorChain(err),
          });
        }
      }
    }

    logger.info("ika_cache_warmup_complete");
  } catch (err) {
    // Non-fatal — warm-up is best-effort. The DKG flow has its own retries.
    logger.warn("ika_cache_warmup_failed", {
      error: err instanceof Error ? err.message : String(err),
      errorChain: extractErrorChain(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Utility — kept here because it is trivial and used in the init loop
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Backward-compatible re-exports
//
// Tests and downstream modules historically imported everything from
// this file.  The re-exports below preserve those paths so the
// refactoring is transparent to consumers.
// ---------------------------------------------------------------------------

export { getErrorMessage, isRateLimitedError, isTransientNetworkFetchError, extractErrorChain } from "./errors";

export {
  invalidateEncryptionKeyCache as invalidateClientEncryptionKeyCache,
  invalidateProtocolParamsCache,
  fetchLatestEncryptionKeyResilient as getLatestNetworkEncryptionKeyResilient,
} from "./encryption-keys";

export type { EncryptionKeyFetchOptions } from "./encryption-keys";
