/**
 * @module ika/errors
 *
 * Centralised error classification for the IKA integration layer.
 *
 * Extracting error utilities into a dedicated module follows the
 * Single Responsibility Principle — these pure functions have no
 * dependency on SDK state, network clients, or caching. They are
 * consumed by every other module in the `ika/` package and by the
 * test suite for direct unit-testing.
 */

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

/** Safely extract a human-readable message from any thrown value. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Extract a combined string of the error message *and* its `cause` message
 * (if present).  The IKA SDK frequently wraps root causes inside a
 * `NetworkError` — inspecting the cause chain is critical for accurate
 * classification.
 */
export function getErrorWithCause(error: unknown): string {
  const message = getErrorMessage(error).toLowerCase();

  const causeMessage =
    error instanceof Error && error.cause
      ? getErrorMessage(error.cause).toLowerCase()
      : "";

  return `${message} ${causeMessage}`;
}

// ---------------------------------------------------------------------------
// Error classification predicates
// ---------------------------------------------------------------------------

/** Returns `true` when the error indicates an HTTP 429 / rate-limit response. */
export function isRateLimitedError(error: unknown): boolean {
  const combined = getErrorWithCause(error);
  return (
    combined.includes("429") ||
    combined.includes("too many requests") ||
    combined.includes("rate limit")
  );
}

/**
 * Returns `true` when the error is a transient network / fetch failure that
 * is likely to succeed on retry — possibly against a different RPC endpoint.
 *
 * The patterns here are derived from observed failures in the IKA SDK's
 * `#fetchEncryptionKeysFromNetwork()` path, Node.js `fetch()` built-in,
 * and common HTTP client error strings.
 */
export function isTransientNetworkFetchError(error: unknown): boolean {
  const combined = getErrorWithCause(error);

  return (
    combined.includes("failed to fetch encryption keys") ||
    combined.includes("failed to fetch objects") ||
    combined.includes("network encryption keys") ||
    combined.includes("network error") ||
    combined.includes("fetch failed") ||
    combined.includes("timeout") ||
    combined.includes("etimedout") ||
    combined.includes("econnreset") ||
    combined.includes("econnrefused") ||
    combined.includes("socket hang up") ||
    isRateLimitedError(error)
  );
}
