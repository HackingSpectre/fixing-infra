/**
 * @module ika/signer
 *
 * Sui keypair loading and cryptographic seed derivation for the IKA
 * sponsored-transaction signer.
 *
 * Extracted from the DKG adapter because keypair management is an
 * independent concern — it reads env config, validates secret material,
 * and returns a ready-to-use keypair.  No SDK or network state involved.
 *
 * Benefits:
 *   • Unit-testable in isolation (mock only env, not the entire SDK).
 *   • Reusable if signing is needed outside the DKG flow (e.g. top-up
 *     transactions, gas refills).
 *   • Secrets handling is co-located in one auditable file.
 */

import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { env } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";
import type { Curve } from "../wallet/types";

// ---------------------------------------------------------------------------
// Keypair loading
// ---------------------------------------------------------------------------

/**
 * Load the Sui Ed25519 keypair that sponsors IKA transactions.
 *
 * Supports two secret formats:
 *   • Bech32 (`suiprivkey1…`) — decoded via `decodeSuiPrivateKey`
 *   • Raw Base-64 — decoded directly
 */
export async function loadSignerKeypair(): Promise<any> {
  const keypairModule = (await import("@mysten/sui/keypairs/ed25519")) as Record<string, any>;
  const cryptoModule = (await import("@mysten/sui/cryptography")) as Record<string, any>;

  const Ed25519Keypair = keypairModule.Ed25519Keypair as {
    fromSecretKey: (secretKey: Uint8Array) => any;
  };

  const raw = env.IKA_SIGNER_SECRET_KEY_BASE64.trim();

  if (raw.startsWith("suiprivkey")) {
    const decodeSuiPrivateKey = cryptoModule.decodeSuiPrivateKey as (input: string) => {
      secretKey: Uint8Array;
    };
    const decoded = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }

  const secretKey = Buffer.from(raw, "base64");
  if (secretKey.length === 0) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, "Invalid IKA_SIGNER_SECRET_KEY_BASE64", 500);
  }

  return Ed25519Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// ---------------------------------------------------------------------------
// Deterministic seed derivation
// ---------------------------------------------------------------------------

/**
 * Derive a per-wallet, per-curve 32-byte seed using HMAC-SHA256.
 *
 * The root seed (`IKA_USER_SHARE_ROOT_SEED_BASE64`) is a server secret
 * that MUST be backed up — loss of this seed means loss of the ability
 * to reconstruct user shares.
 *
 * Domain separation string: `wallet:<uuid>:curve:<curve>`
 */
export function deriveCurveSeed(walletId: string, curve: Curve): Uint8Array {
  const rootSeed = Buffer.from(env.IKA_USER_SHARE_ROOT_SEED_BASE64, "base64");
  if (rootSeed.length === 0) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, "Invalid IKA_USER_SHARE_ROOT_SEED_BASE64", 500);
  }

  const digest = createHmac("sha256", rootSeed)
    .update(`wallet:${walletId}:curve:${curve}`)
    .digest();

  return new Uint8Array(digest);
}
