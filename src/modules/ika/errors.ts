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
// Deep error chain extraction (diagnostic logging)
// ---------------------------------------------------------------------------

/**
 * Walk the full `.cause` chain and extract a structured object suitable
 * for JSON logging.  The IKA SDK wraps errors multiple levels deep:
 *
 *   NetworkError('Failed to fetch encryption keys')
 *     → cause: TypeError('fetch failed')
 *       → cause: Error('connect ECONNREFUSED …')
 *
 * This helper unrolls the whole chain so logs show the **root cause**
 * without needing a debugger.
 */
export function extractErrorChain(error: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!(error instanceof Error)) {
    result.raw = String(error);
    return result;
  }

  result.name = error.name;
  result.message = error.message;

  // Capture common HTTP-ish properties that SDK / fetch errors may carry.
  const anyErr = error as unknown as Record<string, unknown>;
  if (anyErr.status !== undefined) result.status = anyErr.status;
  if (anyErr.statusCode !== undefined) result.statusCode = anyErr.statusCode;
  if (anyErr.code !== undefined) result.code = anyErr.code;
  if (anyErr.errno !== undefined) result.errno = anyErr.errno;
  if (anyErr.syscall !== undefined) result.syscall = anyErr.syscall;
  if (anyErr.address !== undefined) result.address = anyErr.address;
  if (anyErr.port !== undefined) result.port = anyErr.port;

  // Walk the cause chain (max 5 levels to prevent infinite loops).
  let current: unknown = error.cause;
  const causes: Record<string, unknown>[] = [];
  let depth = 0;

  while (current && depth < 5) {
    if (current instanceof Error) {
      const causeEntry: Record<string, unknown> = {
        name: current.name,
        message: current.message,
      };
      const anyCause = current as unknown as Record<string, unknown>;
      if (anyCause.status !== undefined) causeEntry.status = anyCause.status;
      if (anyCause.statusCode !== undefined) causeEntry.statusCode = anyCause.statusCode;
      if (anyCause.code !== undefined) causeEntry.code = anyCause.code;
      if (anyCause.errno !== undefined) causeEntry.errno = anyCause.errno;
      if (anyCause.syscall !== undefined) causeEntry.syscall = anyCause.syscall;
      if (anyCause.address !== undefined) causeEntry.address = anyCause.address;
      if (anyCause.port !== undefined) causeEntry.port = anyCause.port;
      causes.push(causeEntry);
      current = current.cause;
    } else {
      causes.push({ raw: String(current) });
      break;
    }
    depth += 1;
  }

  if (causes.length > 0) {
    result.causes = causes;
  }

  return result;
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
