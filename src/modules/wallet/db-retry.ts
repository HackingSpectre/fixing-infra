/**
 * @module wallet/db-retry
 *
 * Transient database error detection and automatic retry logic.
 *
 * Extracted from the repository so that:
 *   • The retry policy is unit-testable in isolation.
 *   • Any future repository or service that talks to Postgres can
 *     reuse the same helper without duplication.
 *   • Error-pattern matching is co-located and easy to extend for
 *     new providers or cloud-specific error codes.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of attempts before propagating the error. */
const MAX_ATTEMPTS = 3;

/** Base delay between retries (multiplied by attempt number). */
const BASE_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the database error is transient and likely to
 * succeed on retry (connection timeout, reset, etc.).
 */
export function isTransientDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  const cause =
    error instanceof Error && error.cause
      ? String((error.cause as { message?: unknown; code?: unknown }).message ?? error.cause)
      : "";

  const code =
    error instanceof Error && error.cause && typeof error.cause === "object"
      ? String((error.cause as { code?: unknown }).code ?? "")
      : "";

  const normalized = `${message} ${cause} ${code}`.toLowerCase();

  return (
    normalized.includes("connect_timeout") ||
    normalized.includes("timeout") ||
    normalized.includes("connection terminated") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout")
  );
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/**
 * Execute `operation` with automatic retry on transient DB errors.
 *
 * Uses linear back-off: `BASE_DELAY_MS × attempt`.
 */
export async function withDbRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientDbError(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      await delay(BASE_DELAY_MS * attempt);
    }
  }

  // Unreachable, but satisfies TypeScript.
  throw lastError;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
