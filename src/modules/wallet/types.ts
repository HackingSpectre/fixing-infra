export type Curve = "ed25519" | "secp256k1";
export type Chain = "sui" | "solana" | "evm" | "bitcoin";
export type WalletStatus = "creating" | "provisioning" | "ready" | "degraded" | "failed";

export interface Identity {
  id: string;
  provider: "google";
  providerSub: string;
  email: string | null;
}

export interface Wallet {
  id: string;
  identityId: string;
  status: WalletStatus;
}

export interface WalletSigner {
  id: string;
  walletId: string;
  curve: Curve;
  dwalletId: string;
  dwalletCapId: string;
  publicKeyHex: string;
  state: "pending" | "active" | "failed";
}

export interface WalletAddress {
  id: string;
  walletId: string;
  chain: Chain;
  address: string;
  sourceCurve: Curve;
}

export interface ProvisioningJob {
  id: string;
  walletId: string;
  idempotencyKey: string;
  status: "queued" | "running" | "partial" | "completed" | "failed";
}

export interface ContinueWithGoogleResult {
  walletId: string;
  status: WalletStatus;
  addresses: Partial<Record<Chain, string>>;
  sessionToken: string;
  provisioningQueued: boolean;
}
