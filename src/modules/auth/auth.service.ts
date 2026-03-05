import { randomUUID } from "crypto";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";
import type { ProvisioningService } from "../wallet/provisioning.service";
import { WalletRepository } from "../wallet/repository";
import type { ContinueWithGoogleResult } from "../wallet/types";
import { GoogleTokenVerifier } from "./google-verifier";
import { SessionService } from "./session.service";

export class AuthService {
  constructor(
    private readonly googleTokenVerifier: GoogleTokenVerifier,
    private readonly walletRepository: WalletRepository,
    private readonly sessionService: SessionService,
    private readonly provisioningService: ProvisioningService,
  ) {}

  async continueWithGoogle(input: {
    idToken: string;
    idempotencyKey?: string;
  }): Promise<ContinueWithGoogleResult> {
    if (!input.idToken) {
      throw new AppError(ERROR_CODES.BAD_REQUEST, "idToken is required", 400);
    }

    const identity = await this.googleTokenVerifier.verify(input.idToken);
    const identityRow = await this.walletRepository.upsertIdentity(identity.sub, identity.email);
    const wallet = (await this.walletRepository.findWalletByIdentity(identityRow.id)) ??
      (await this.walletRepository.createWallet(identityRow.id));

    const sessionToken = this.sessionService.sign({
      walletId: wallet.id,
      providerSub: identity.sub,
    });

    if (wallet.status === "ready") {
      const addresses = await this.walletRepository.getAddresses(wallet.id);
      return {
        walletId: wallet.id,
        status: wallet.status,
        addresses: Object.fromEntries(addresses.map((address) => [address.chain, address.address])),
        sessionToken,
        provisioningQueued: false,
      };
    }

    const provisioning = await this.provisioningService.requestProvisioning(wallet.id, input.idempotencyKey ?? randomUUID());

    const addresses = await this.walletRepository.getAddresses(wallet.id);
    const refreshedWallet = await this.walletRepository.getWallet(wallet.id);

    return {
      walletId: wallet.id,
      status: refreshedWallet?.status ?? wallet.status,
      addresses: Object.fromEntries(addresses.map((address) => [address.chain, address.address])),
      sessionToken,
      provisioningQueued: provisioning.queued,
    };
  }
}
