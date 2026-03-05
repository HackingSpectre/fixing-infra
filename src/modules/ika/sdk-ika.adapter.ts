/**
 * @module ika/sdk-ika.adapter
 *
 * DKG orchestration adapter — the only class in the IKA module.
 *
 * This is now a **pure sequencer**: it imports helpers from the
 * single-responsibility modules (`signer`, `transaction-utils`,
 * `encryption-keys`, `errors`, `ika.client`) and wires them
 * together in the correct order to provision a shared dWallet.
 *
 * No cryptographic logic, RPC resolution, or error classification
 * lives here — each concern is one import away and independently
 * testable.
 *
 * ## Encryption-key optimisation (SDK 0.3.1 workaround)
 *
 * The SDK's `prepareDKGAsync()` calls `getProtocolPublicParameters()`
 * which internally uses `fetchEncryptionKeysFromNetwork()` — a private
 * method that **always hits the network** even when encryption keys are
 * already cached (it bypasses the dedup-promise guard in
 * `fetchEncryptionKeys()`).  Each invocation makes 5–10 sequential RPC
 * calls.  Running two curves means 10–20 calls in rapid succession,
 * triggering Sui testnet 429 rate-limits.
 *
 * **Fix:** We use `prepareDKG` (sync) instead of `prepareDKGAsync`.  The
 * sync version takes pre-loaded `protocolPublicParameters` directly and
 * never touches the network.  We fetch the params ourselves via
 * `getCachedOrFetchProtocolParams()` which:
 *   1. Checks the SDK's own `getCachedProtocolPublicParameters()` first.
 *   2. Falls back to `getProtocolPublicParameters()` only on a cache miss.
 * Combined with warm-up at client init, the second curve always reads
 * from cache → zero RPC calls → no 429.
 */

import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  getInitializedIkaClientContext,
  resetIkaClientContext,
} from "./ika.client";
import { getErrorMessage, isTransientNetworkFetchError, isRateLimitedError, extractErrorChain } from "./errors";
import {
  invalidateEncryptionKeyCache,
  invalidateProtocolParamsCache,
  fetchLatestEncryptionKeyResilient,
} from "./encryption-keys";
import { loadSignerKeypair, deriveCurveSeed } from "./signer";
import {
  assertNonEmptyString,
  extractCreatedObjectId,
  extractPublicKeyHex,
  resolveIkaCoinObjectId,
  executeTransaction,
  toSdkCurve,
} from "./transaction-utils";
import type { IkaAdapter, ProvisionSignerResult } from "./ika.adapter";
import type { Curve } from "../wallet/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum end-to-end attempts for the full DKG flow. */
const MAX_DKG_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Module-cached SDK imports (resolved once, reused across calls)
// ---------------------------------------------------------------------------

let _sdkCache: Record<string, any> | null = null;
let _txModuleCache: Record<string, any> | null = null;

async function getSdkModules() {
  if (!_sdkCache) {
    _sdkCache = (await import("@ika.xyz/sdk")) as Record<string, any>;
  }
  if (!_txModuleCache) {
    _txModuleCache = (await import("@mysten/sui/transactions")) as Record<string, any>;
  }
  return { sdk: _sdkCache, txModule: _txModuleCache };
}

// ---------------------------------------------------------------------------
// Protocol-params helper (SDK cache-first, network-fallback)
// ---------------------------------------------------------------------------

/**
 * Retrieve protocol public parameters for a curve, preferring the SDK's
 * internal cache.  This avoids `getProtocolPublicParameters()` when
 * possible because that method calls `fetchEncryptionKeysFromNetwork()`
 * directly (bypassing the dedup guard), causing 5–10 RPC calls every time.
 *
 * Flow:
 *   1. Get encryption key from cache via `getAllNetworkEncryptionKeys()`
 *      (returns from `cachedEncryptionKeys` if populated — zero RPC).
 *   2. Check `getCachedProtocolPublicParameters(keyId, curve)` — if the
 *      warm-up or a previous DKG already populated this, return immediately.
 *   3. Only on a true cache miss, fall back to `getProtocolPublicParameters()`
 *      which will hit the network.
 */
async function getCachedOrFetchProtocolParams(
  ikaClient: any,
  sdkCurve: unknown,
): Promise<{ protocolPublicParameters: Uint8Array; encryptionKeyId: string }> {
  // Step 1: Get the latest encryption key (cache-respecting path).
  const keys = await ikaClient.getAllNetworkEncryptionKeys();
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("No network encryption keys available");
  }
  const latestKey = keys[keys.length - 1];
  const encryptionKeyId: string = latestKey.id;

  // Step 2: Check SDK's protocol params cache.
  if (typeof ikaClient.getCachedProtocolPublicParameters === "function") {
    const cached = ikaClient.getCachedProtocolPublicParameters(encryptionKeyId, sdkCurve);
    if (cached) {
      logger.info("protocol_params_from_cache", { encryptionKeyId, curve: String(sdkCurve) });
      return { protocolPublicParameters: cached, encryptionKeyId };
    }
  }

  // Step 3: Cache miss — fetch from network (this calls fetchEncryptionKeysFromNetwork).
  logger.info("protocol_params_cache_miss", { encryptionKeyId, curve: String(sdkCurve) });
  try {
    const params = await ikaClient.getProtocolPublicParameters(undefined, sdkCurve);
    return { protocolPublicParameters: params, encryptionKeyId };
  } catch (error) {
    logger.error("protocol_params_fetch_failed", {
      encryptionKeyId,
      curve: String(sdkCurve),
      error: error instanceof Error ? error.message : String(error),
      errorChain: extractErrorChain(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SdkIkaAdapter implements IkaAdapter {
  async provisionSigner(input: {
    walletId: string;
    curve: Curve;
    correlationId: string;
  }): Promise<ProvisionSignerResult> {
    const { walletId, curve, correlationId } = input;

    // -- SDK imports (cached after first call) --
    const { sdk, txModule } = await getSdkModules();

    const IkaTransaction = sdk.IkaTransaction as new (args: Record<string, unknown>) => any;
    const UserShareEncryptionKeys = sdk.UserShareEncryptionKeys as {
      fromRootSeedKey: (seed: Uint8Array, curve: unknown) => Promise<any>;
    };
    // Use prepareDKG (sync) — takes pre-loaded protocolPublicParameters,
    // never touches the network.  This is the core 429 fix.
    const prepareDKG = sdk.prepareDKG as (...args: unknown[]) => Promise<any>;
    const createRandomSessionIdentifier = sdk.createRandomSessionIdentifier as () => Uint8Array;
    const Transaction = txModule.Transaction as new () => any;

    // -- Deterministic key material --
    const signerKeypair = await loadSignerKeypair();
    const signerAddress = assertNonEmptyString(
      signerKeypair.toSuiAddress?.(),
      "sponsor signer address",
    );
    const sdkCurve = toSdkCurve(sdk, curve);
    const userShareSeed = deriveCurveSeed(walletId, curve);

    // -- Mutable state populated during the retry loop --
    let ikaClient: any | null = null;
    let suiClient: any | null = null;
    let rpcUrl = "unknown";
    let userShareEncryptionKeys: any | null = null;
    let sessionIdentifierBytes: Uint8Array | null = null;
    let dkgRequestInput: any | null = null;
    let networkEncryptionKey: any | null = null;

    let lastError: unknown;

    // ------------------------------------------------------------------
    // Phase 1 — Prepare DKG (retried across RPC endpoints)
    //
    // Uses prepareDKG (sync) with pre-loaded protocol params instead of
    // prepareDKGAsync, avoiding the SDK bug where
    // getProtocolPublicParameters() → fetchEncryptionKeysFromNetwork()
    // always hits the network (bypasses dedup-promise guard).
    //
    // After warm-up, the second curve reads protocol params from the
    // SDK's cache → zero RPC calls → no 429.
    // ------------------------------------------------------------------
    for (let attempt = 1; attempt <= MAX_DKG_ATTEMPTS; attempt += 1) {
      try {
        ({ ikaClient, suiClient, rpcUrl } = await resolveClient(attempt, ikaClient));

        logger.info("shared_dwallet_provisioning_started", {
          walletId, curve, correlationId, rpcUrl, signerAddress, attempt,
        });

        logStep(walletId, curve, correlationId, "1/7 derive_curve_seed_and_user_keys", attempt);
        userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(
          userShareSeed,
          sdkCurve,
        );

        logStep(walletId, curve, correlationId, "2/7 prepare_dkg", attempt);
        sessionIdentifierBytes = createRandomSessionIdentifier();

        // Fetch protocol params (cache-first, network-fallback).
        const { protocolPublicParameters, encryptionKeyId } =
          await getCachedOrFetchProtocolParams(ikaClient, sdkCurve);

        // Use prepareDKG (sync) — zero network calls.
        dkgRequestInput = await prepareDKG(
          protocolPublicParameters,
          sdkCurve,
          userShareEncryptionKeys.encryptionKey,
          sessionIdentifierBytes,
          signerAddress,
        );

        // Encryption key for the transaction — already in SDK cache from
        // getAllNetworkEncryptionKeys() called in getCachedOrFetchProtocolParams.
        logStep(walletId, curve, correlationId, "3/7 resolve_network_encryption_key", attempt);
        networkEncryptionKey = await ikaClient.getLatestNetworkEncryptionKey();

        if (!networkEncryptionKey?.id) {
          networkEncryptionKey = await fetchLatestEncryptionKeyResilient(ikaClient, {
            attempts: 2,
            delayMs: 3_000,
          });
        }

        break; // success — exit retry loop
      } catch (error) {
        lastError = error;
        const retryable = isTransientNetworkFetchError(error);
        const is429 = isRateLimitedError(error);

        logger.warn("dwallet_step_retry", {
          walletId, curve, correlationId,
          step: "prepare_dkg_or_fetch_encryption_key",
          attempt, retryable, is429,
          error: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause ? getErrorMessage(error.cause) : undefined,
          errorChain: extractErrorChain(error),
        });

        if (!retryable || attempt === MAX_DKG_ATTEMPTS) {
          throw error;
        }

        // Granular cache invalidation:
        //   • Always invalidate encryption keys (they may be stale).
        //   • Only invalidate protocol params if the error was NOT a 429.
        //     On 429 the data itself is fine — we just hit the rate limit.
        //     Preserving protocol params avoids re-fetching ~100KB+ on retry.
        if (ikaClient) {
          invalidateEncryptionKeyCache(ikaClient);
          if (!is429) {
            invalidateProtocolParamsCache(ikaClient);
          }
        }

        // 429 gets a longer cooldown to let the rate-limit window expire.
        const backoffMs = is429 ? 5_000 * attempt : 2_000 * attempt;
        logger.info("dwallet_retry_backoff", { walletId, curve, correlationId, attempt, backoffMs, is429 });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // -- Guard: all prerequisites must be populated --
    if (
      !ikaClient || !suiClient || !userShareEncryptionKeys ||
      !sessionIdentifierBytes || !dkgRequestInput || !networkEncryptionKey
    ) {
      throw new Error(
        `Unable to prepare DKG prerequisites after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }

    // ------------------------------------------------------------------
    // Phase 2 — Build & submit the DKG transaction
    // ------------------------------------------------------------------
    const transaction = new Transaction();
    if (typeof transaction.setSender === "function") {
      transaction.setSender(signerAddress);
    }

    const ikaTransaction = new IkaTransaction({
      ikaClient,
      transaction,
      userShareEncryptionKeys,
    });

    logStep(walletId, curve, correlationId, "4/7 register_encryption_key_and_resolve_fee_coins");
    await ikaTransaction.registerEncryptionKey({ curve: sdkCurve });

    const ikaCoinObjectId = await resolveIkaCoinObjectId(suiClient, signerAddress);
    const ikaCoin = transaction.object(ikaCoinObjectId);
    const [suiCoin] = transaction.splitCoins(transaction.gas, [env.IKA_FEE_SUI_AMOUNT_MIST]);

    await ikaTransaction.requestDWalletDKGWithPublicUserShare({
      publicKeyShareAndProof: dkgRequestInput.userDKGMessage,
      publicUserSecretKeyShare: dkgRequestInput.userSecretKeyShare,
      userPublicOutput: dkgRequestInput.userPublicOutput,
      curve: sdkCurve,
      dwalletNetworkEncryptionKeyId: networkEncryptionKey.id,
      ikaCoin,
      suiCoin,
      sessionIdentifier: ikaTransaction.registerSessionIdentifier(sessionIdentifierBytes),
    });

    logStep(walletId, curve, correlationId, "5/7 submit_transaction");
    const executeResult = await executeTransaction(suiClient, signerKeypair, transaction);

    // ------------------------------------------------------------------
    // Phase 3 — Extract artifacts & wait for active state
    // ------------------------------------------------------------------
    const objectChanges = (executeResult as { objectChanges?: unknown })?.objectChanges;
    const dwalletId = extractCreatedObjectId(objectChanges, "::dwallet::DWallet");
    const dwalletCapId = extractCreatedObjectId(objectChanges, "::dwallet::DWalletCap");

    if (!dwalletId || !dwalletCapId) {
      throw new Error("Could not extract dWallet artifacts from transaction execution");
    }

    logStep(walletId, curve, correlationId, "6/7 wait_for_active_state");
    logger.info("dwallet_step", { walletId, curve, correlationId, step: "6/7 wait_for_active_state", dwalletId });

    const activeDWallet = await ikaClient.getDWalletInParticularState(dwalletId, "Active", {
      timeout: env.IKA_ACTIVE_POLL_TIMEOUT_MS,
      interval: env.IKA_ACTIVE_POLL_INTERVAL_MS,
    });

    if (!activeDWallet?.public_user_secret_key_share) {
      throw new Error("Created dWallet is not detected as shared dWallet");
    }

    const publicKeyHex = extractPublicKeyHex(activeDWallet);

    logStep(walletId, curve, correlationId, "7/7 extract_public_key_and_finalize");
    logger.info("dwallet_step", { walletId, curve, correlationId, step: "7/7 extract_public_key_and_finalize", dwalletId, dwalletCapId });

    logger.info("shared_dwallet_provisioning_completed", {
      walletId, curve, correlationId, dwalletId, dwalletCapId,
    });

    return { dwalletId, dwalletCapId, publicKeyHex };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Graduated client resolution strategy:
 *   attempt 1 → use existing (or fresh) client; SDK caches should be warm.
 *   attempt 2 → invalidate encryption-key cache only (preserve protocol
 *               params), keep same RPC endpoint.
 *   attempt 3+ → full context reset + rotate to next RPC endpoint.
 *               The new client's warmUpSdkCaches() will re-populate caches.
 */
async function resolveClient(
  attempt: number,
  currentIkaClient: any | null,
): Promise<{ ikaClient: any; suiClient: any; rpcUrl: string }> {
  if (attempt === 2 && currentIkaClient) {
    // Only invalidate encryption keys — protocol params are still valid
    // (same epoch, same encryption key data, just possibly stale key list).
    invalidateEncryptionKeyCache(currentIkaClient);
    return getInitializedIkaClientContext({ forceRefresh: false });
  }

  if (attempt > 2) {
    // Full reset — new RPC endpoint, new client, fresh caches.
    // warmUpSdkCaches() runs inside getInitializedIkaClientContext.
    resetIkaClientContext();
    return getInitializedIkaClientContext({ forceRefresh: true, rotateRpcCandidate: true });
  }

  return getInitializedIkaClientContext({ forceRefresh: false });
}

/** Structured log helper — keeps the orchestrator body scannable. */
function logStep(
  walletId: string,
  curve: string,
  correlationId: string,
  step: string,
  attempt?: number,
): void {
  logger.info("dwallet_step", {
    walletId, curve, correlationId, step,
    ...(attempt !== undefined && { attempt }),
  });
}
