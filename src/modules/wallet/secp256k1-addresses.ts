/**
 * @module wallet/secp256k1-addresses
 *
 * Address derivation for chains that use the Secp256k1 elliptic curve:
 *
 *   • **EVM**     — Keccak-256 hash of uncompressed point (last 20 bytes)
 *   • **Bitcoin** — Bech32-encoded RIPEMD-160(SHA-256(compressed point))
 *
 * This module is intentionally stateless — every function is a pure
 * transform from a hex-encoded public key to a chain-specific address.
 * No SDK, no network, no side effects.
 */

import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { ripemd160 } from "@noble/hashes/legacy";
import { bech32 } from "@scure/base";
import { Point } from "@noble/secp256k1";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function parseSecp256k1Point(publicKeyHex: string): typeof Point.prototype {
  const normalized = normalizeHex(publicKeyHex);
  try {
    return Point.fromHex(normalized);
  } catch (error) {
    throw new AppError(
      ERROR_CODES.BAD_REQUEST,
      `Invalid secp256k1 public key: ${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive an EVM (Ethereum-compatible) address from a secp256k1 public key.
 *
 * Algorithm:
 *   1. Decompress to 65-byte uncompressed point
 *   2. `Keccak-256( uncompressed[1..] )`   — drop the 0x04 prefix
 *   3. Take last 20 bytes
 *
 * @returns `0x`-prefixed 40-character hex string.
 */
export function deriveEvmAddress(secp256k1PublicKeyHex: string): string {
  const point = parseSecp256k1Point(secp256k1PublicKeyHex);
  const uncompressed = point.toBytes(false);      // 65 bytes: 04 || x || y
  const hash = keccak_256(uncompressed.slice(1));  // hash x || y
  return `0x${bytesToHex(hash.slice(-20))}`;
}

/**
 * Derive a Bitcoin mainnet P2WPKH (Bech32) address from a secp256k1 public key.
 *
 * Algorithm:
 *   1. Compress to 33-byte point
 *   2. `Hash160 = RIPEMD-160( SHA-256( compressed ) )`
 *   3. Bech32-encode with witness version 0 and `bc` prefix
 *
 * @returns Bech32-encoded Bitcoin address string (e.g. `bc1q…`).
 */
export function deriveBitcoinAddress(secp256k1PublicKeyHex: string): string {
  const point = parseSecp256k1Point(secp256k1PublicKeyHex);
  const compressed = point.toBytes(true);           // 33 bytes
  const hash160 = ripemd160(sha256(compressed));
  const words = bech32.toWords(hash160);
  return bech32.encode("bc", [0, ...words]);
}
