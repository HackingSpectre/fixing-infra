/**
 * @module wallet/address-derivation.service
 *
 * Façade that delegates to the per-curve address derivation modules:
 *
 *   • `./ed25519-addresses`   — Sui & Solana
 *   • `./secp256k1-addresses` — EVM & Bitcoin
 *
 * The class preserves the existing `AddressDerivationService` interface
 * so every consumer (server.ts, provisioning.service, tests) continues
 * to work without import changes.
 *
 * If you only need one curve, import the specific module directly — it
 * is lighter and avoids pulling in the other curve's dependencies.
 */

import { deriveSuiAddress, deriveSolanaAddress } from "./ed25519-addresses";
import { deriveEvmAddress, deriveBitcoinAddress } from "./secp256k1-addresses";

export class AddressDerivationService {
  /** Sui address from Ed25519 public key. */
  deriveSuiAddress(ed25519PublicKeyHex: string): string {
    return deriveSuiAddress(ed25519PublicKeyHex);
  }

  /** Solana address from Ed25519 public key. */
  deriveSolanaAddress(ed25519PublicKeyHex: string): string {
    return deriveSolanaAddress(ed25519PublicKeyHex);
  }

  /** EVM address from Secp256k1 public key. */
  deriveEvmAddress(secp256k1PublicKeyHex: string): string {
    return deriveEvmAddress(secp256k1PublicKeyHex);
  }

  /** Bitcoin P2WPKH Bech32 address from Secp256k1 public key. */
  deriveBitcoinAddress(secp256k1PublicKeyHex: string): string {
    return deriveBitcoinAddress(secp256k1PublicKeyHex);
  }
}

// Also export the per-curve functions directly for callers that prefer
// tree-shakeable imports over the class-based API.
export { deriveSuiAddress, deriveSolanaAddress } from "./ed25519-addresses";
export { deriveEvmAddress, deriveBitcoinAddress } from "./secp256k1-addresses";
