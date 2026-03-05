/**
 * @module wallet/ed25519-addresses
 *
 * Address derivation for chains that use the Ed25519 elliptic curve:
 *
 *   • **Sui**    — Blake2b-256 hash of (0x00 flag || 32-byte pubkey)
 *   • **Solana** — Raw Base58-encoded 32-byte public key
 *
 * This module is intentionally stateless — every function is a pure
 * transform from a hex-encoded public key to a chain-specific address.
 * No SDK, no network, no side effects.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { base58 } from "@scure/base";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new AppError(ERROR_CODES.BAD_REQUEST, "Invalid hex public key", 400);
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function assertEd25519Key(pub: Uint8Array): void {
  if (pub.length !== 32) {
    throw new AppError(
      ERROR_CODES.BAD_REQUEST,
      "ed25519 public key must be 32 bytes",
      400,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a Sui address from a 32-byte Ed25519 public key.
 *
 * Algorithm: `Blake2b-256( 0x00 || pubkey )`
 *
 * @returns `0x`-prefixed 64-character hex string.
 */
export function deriveSuiAddress(ed25519PublicKeyHex: string): string {
  const pub = hexToBytes(ed25519PublicKeyHex);
  assertEd25519Key(pub);

  const flagAndKey = new Uint8Array(33);
  flagAndKey[0] = 0x00; // Ed25519 flag byte
  flagAndKey.set(pub, 1);

  const digest = blake2b(flagAndKey, { dkLen: 32 });
  return `0x${bytesToHex(digest)}`;
}

/**
 * Derive a Solana address from a 32-byte Ed25519 public key.
 *
 * Algorithm: `Base58( pubkey )`   — Solana addresses are just
 * the raw public key in Base58.
 *
 * @returns Base58-encoded address string.
 */
export function deriveSolanaAddress(ed25519PublicKeyHex: string): string {
  const pub = hexToBytes(ed25519PublicKeyHex);
  assertEd25519Key(pub);

  return base58.encode(pub);
}
