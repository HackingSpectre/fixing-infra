/**
 * @module ika/transaction-utils
 *
 * Pure helper functions for IKA / Sui transaction construction and
 * result parsing.
 *
 * These are stateless utilities that operate on raw data structures
 * returned by the Sui JSON-RPC.  Extracting them:
 *
 *   • Eliminates duplication if transaction execution is needed in
 *     multiple flows (DKG, signing, top-ups).
 *   • Makes each helper independently testable with fixture data.
 *   • Keeps the DKG orchestrator focused on sequencing, not parsing.
 */

import { Buffer } from "node:buffer";
import { env } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Throw if `value` is not a non-empty string. */
export function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string field: ${fieldName}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Object-change extraction
// ---------------------------------------------------------------------------

/**
 * Search the `objectChanges` array from a Sui transaction response for
 * a newly-created object whose `objectType` contains `typeFragment`.
 *
 * @returns The `objectId` of the first match, or `null`.
 */
export function extractCreatedObjectId(
  objectChanges: unknown,
  typeFragment: string,
): string | null {
  if (!Array.isArray(objectChanges)) return null;

  for (const change of objectChanges) {
    if (!change || typeof change !== "object") continue;

    const candidate = change as {
      type?: unknown;
      objectType?: unknown;
      objectId?: unknown;
    };

    if (candidate.type !== "created") continue;
    if (typeof candidate.objectType !== "string") continue;
    if (!candidate.objectType.includes(typeFragment)) continue;
    if (typeof candidate.objectId !== "string") continue;

    return candidate.objectId;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public key extraction from dWallet state
// ---------------------------------------------------------------------------

/**
 * Extract the hex-encoded public key from an active dWallet response.
 *
 * The SDK returns the key in multiple possible locations depending on
 * the protocol version — this function checks all known paths.
 */
export function extractPublicKeyHex(activeDWallet: any): string {
  const candidates: unknown[] = [
    activeDWallet?.public_key,
    activeDWallet?.publicKey,
    activeDWallet?.state?.Active?.public_key,
    activeDWallet?.state?.Active?.publicKey,
    activeDWallet?.state?.Completed?.public_key,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate.startsWith("0x") ? candidate.slice(2) : candidate;
    }

    if (Array.isArray(candidate)) {
      return Buffer.from(Uint8Array.from(candidate as number[])).toString("hex");
    }
  }

  throw new Error("Unable to extract public key from active dWallet response");
}

// ---------------------------------------------------------------------------
// Coin resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the IKA fee-coin object ID for a given signer address.
 *
 * If `IKA_FEE_IKA_COIN_OBJECT_ID` is configured, it is returned directly.
 * Otherwise the on-chain coin list is queried for a coin with balance > 0.
 */
export async function resolveIkaCoinObjectId(
  suiClient: any,
  signerAddress: string,
): Promise<string> {
  if (env.IKA_FEE_IKA_COIN_OBJECT_ID && env.IKA_FEE_IKA_COIN_OBJECT_ID.trim().length > 0) {
    return env.IKA_FEE_IKA_COIN_OBJECT_ID;
  }

  const coinsResult = await suiClient.getCoins({
    owner: signerAddress,
    coinType: env.IKA_FEE_IKA_COIN_TYPE,
  });

  const coins = Array.isArray(coinsResult?.data) ? coinsResult.data : [];
  const usable = coins.find((coin: { coinObjectId?: unknown; balance?: unknown }) => {
    if (typeof coin?.coinObjectId !== "string") return false;
    return hasPositiveBalance(coin.balance);
  });

  if (!usable || typeof usable.coinObjectId !== "string") {
    throw new AppError(
      ERROR_CODES.SPONSOR_BALANCE_LOW,
      `No usable IKA coin object found for signer address (${signerAddress})`,
      503,
    );
  }

  return usable.coinObjectId;
}

// ---------------------------------------------------------------------------
// Transaction execution
// ---------------------------------------------------------------------------

/**
 * Sign and execute a Sui transaction with standard show-options enabled.
 */
export async function executeTransaction(
  suiClient: any,
  signerKeypair: any,
  transaction: any,
): Promise<any> {
  return suiClient.signAndExecuteTransaction({
    signer: signerKeypair,
    transaction,
    options: {
      showEffects: true,
      showObjectChanges: true,
      showEvents: true,
    },
  });
}

// ---------------------------------------------------------------------------
// SDK curve mapping
// ---------------------------------------------------------------------------

import type { Curve } from "../wallet/types";

/** Map our domain `Curve` union to the SDK's `Curve` enum value. */
export function toSdkCurve(sdk: Record<string, any>, curve: Curve): any {
  if (!sdk.Curve) {
    throw new Error("SDK Curve enum not available");
  }
  return curve === "ed25519" ? sdk.Curve.ED25519 : sdk.Curve.SECP256K1;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasPositiveBalance(raw: unknown): boolean {
  if (typeof raw === "bigint") return raw > 0n;
  if (typeof raw === "number") return raw > 0;
  if (typeof raw === "string") {
    try {
      return BigInt(raw) > 0n;
    } catch {
      return false;
    }
  }
  return false;
}
