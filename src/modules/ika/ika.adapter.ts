import type { Curve } from "../wallet/types";

export interface ProvisionSignerResult {
  dwalletId: string;
  dwalletCapId: string;
  publicKeyHex: string;
}

export interface IkaAdapter {
  provisionSigner(input: { walletId: string; curve: Curve; correlationId: string }): Promise<ProvisionSignerResult>;
}
