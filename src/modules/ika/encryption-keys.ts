/**
 * @module ika/encryption-keys
 *
 * Resilient fetching and cache management for IKA network encryption keys.
 *
 * Separated from the client lifecycle module because encryption-key
 * retrieval is a discrete retry-able operation that operates *on* an
 * already-initialised IkaClient instance. Keeping it in its own module:
 *
 *   • Makes the retry / back-off strategy independently testable.
 *   • Respects the Single Responsibility Principle — this module owns
 *     "get me an encryption key, reliably" and nothing else.
 *   • Keeps the main client module focused on construction / teardown.
 */

import { logger } from "../../config/logger";
import {
  getErrorMessage,
  isTransientNetworkFetchError,
  extractErrorChain,
} from "./errors";
import { readFromDiskCache, writeToDiskCache } from "./disk-cache";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default back-off base between encryption-key fetch attempts (ms). */
const DEFAULT_RETRY_DELAY_MS = 3_000;

/** Extra back-off when the failure was a 429 rate-limit (ms). */
const RATE_LIMIT_BACKOFF_MS = 5_000;

/** Default maximum number of fetch attempts. */
const DEFAULT_MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate the encryption-key cache on an IkaClient instance, forcing a
 * fresh network fetch on the next call.
 *
 * The SDK exposes two methods — we prefer the narrower one when available:
 *   • `invalidateEncryptionKeyCache()` — clears only encryption-key data
 *   • `invalidateCache()` — clears everything (full reset)
 *
 * NOTE: This does NOT clear protocol public parameters (large cached data).
 * Use `invalidateProtocolParamsCache` for that.
 */
export function invalidateEncryptionKeyCache(ikaClient: any): void {
  try {
    if (typeof ikaClient.invalidateEncryptionKeyCache === "function") {
      ikaClient.invalidateEncryptionKeyCache();
    } else if (typeof ikaClient.invalidateCache === "function") {
      ikaClient.invalidateCache();
    }
  } catch {
    // Best-effort — callers handle the consequence of stale data via retries.
  }
}

/**
 * Invalidate only the protocol public parameters cache.
 * This is a targeted invalidation that preserves encryption keys and objects.
 *
 * @param encryptionKeyID — If provided, only invalidate params for this key.
 * @param curve — If provided alongside encryptionKeyID, invalidate only that
 *                specific (key, curve) combination.
 */
export function invalidateProtocolParamsCache(
  ikaClient: any,
  encryptionKeyID?: string,
  curve?: unknown,
): void {
  try {
    if (typeof ikaClient.invalidateProtocolPublicParametersCache === "function") {
      ikaClient.invalidateProtocolPublicParametersCache(encryptionKeyID, curve);
    }
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Resilient fetch
// ---------------------------------------------------------------------------

export interface EncryptionKeyFetchOptions {
  /** Maximum number of attempts (default: 4). */
  attempts?: number;
  /** Base delay in ms — multiplied by attempt number for linear back-off (default: 10 000). */
  delayMs?: number;
}

/**
 * Fetch the latest network encryption key with automatic retries, cache
 * invalidation between attempts, and a fallback to `getAllNetworkEncryptionKeys`.
 *
 * Optimised to:
 *   1. Return from SDK cache on first attempt (zero RPC if warm-up succeeded).
 *   2. Only invalidate the encryption-key cache (not protocol params) on retry.
 *   3. Apply longer back-off after 429 rate-limit responses.
 *
 * @throws {Error} When all attempts are exhausted.
 */
export async function fetchLatestEncryptionKeyResilient(
  ikaClient: any,
  options?: EncryptionKeyFetchOptions,
): Promise<any> {
  const maxAttempts = options?.attempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = options?.delayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastError: unknown;

  const diskFilename = 'latest-encryption-keys.json';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // On retries, invalidate only the encryption-key cache (not protocol
    // params — those are expensive to re-fetch and keyed separately).
    if (attempt > 1) {
      invalidateEncryptionKeyCache(ikaClient);
    }

    // --- Step 0: ALWAYS check disk cache first (every attempt, not just attempt 1) ---
    const diskKeys = await readFromDiskCache(diskFilename);
    if (diskKeys && Array.isArray(diskKeys) && diskKeys.length > 0) {
      const candidate = diskKeys[diskKeys.length - 1];
      if (candidate?.id) {
        logger.info("encryption_keys_from_disk_cache", {
          keyCount: diskKeys.length,
          attempt,
        });

        // Re-warm the SDK memory cache so downstream SDK calls don't hit network
        if (typeof ikaClient.setNetworkEncryptionKeysInCache === "function") {
          ikaClient.setNetworkEncryptionKeysInCache(diskKeys);
        }

        return candidate;
      }
    }

    // --- Disk cache empty — fall back to network ---
    // Primary path: getLatestNetworkEncryptionKey
    try {
      const latest = await ikaClient.getLatestNetworkEncryptionKey();
      if (latest?.id) {
        return latest;
      }
    } catch (error) {
      lastError = error;

      const is429 = is429RateLimit(error);
      logger.warn("encryption_key_fetch_attempt_failed", {
        attempt,
        method: "getLatestNetworkEncryptionKey",
        is429,
        error: getErrorMessage(error),
        cause: error instanceof Error && error.cause ? getErrorMessage(error.cause) : undefined,
        errorChain: extractErrorChain(error),
      });

      if (!isTransientNetworkFetchError(error) || attempt === maxAttempts) {
        break;
      }

      const backoff = is429
        ? RATE_LIMIT_BACKOFF_MS * attempt
        : baseDelay * attempt;
      await delay(backoff);
      continue;
    }

    // Fallback path: getAllNetworkEncryptionKeys → pick last
    try {
      invalidateEncryptionKeyCache(ikaClient);
      const allKeys = await ikaClient.getAllNetworkEncryptionKeys();
      if (Array.isArray(allKeys) && allKeys.length > 0) {
        // Persist to disk so future calls never hit network
        await writeToDiskCache(diskFilename, allKeys);

        const candidate = allKeys[allKeys.length - 1];
        if (candidate?.id) {
          return candidate;
        }
      }
    } catch (error) {
      lastError = error;
      logger.warn("encryption_key_fetch_attempt_failed", {
        attempt,
        method: "getAllNetworkEncryptionKeys",
        error: getErrorMessage(error),
        cause: error instanceof Error && error.cause ? getErrorMessage(error.cause) : undefined,
        errorChain: extractErrorChain(error),
      });

      if (!isTransientNetworkFetchError(error) || attempt === maxAttempts) {
        break;
      }
    }

    if (attempt < maxAttempts) {
      const backoff = is429RateLimit(lastError)
        ? RATE_LIMIT_BACKOFF_MS * attempt
        : baseDelay * attempt;
      await delay(backoff);
    }
  }

  throw new Error(
    `Network error: Failed to fetch encryption keys after ${maxAttempts} attempts${
      lastError ? ` (${getErrorMessage(lastError)})` : ""
    }`,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if an error is specifically a 429 rate-limit response. */
function is429RateLimit(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  const causeMsg =
    error instanceof Error && error.cause
      ? getErrorMessage(error.cause).toLowerCase()
      : "";
  return (
    msg.includes("429") ||
    causeMsg.includes("429") ||
    msg.includes("too many requests") ||
    causeMsg.includes("too many requests")
  );
}
