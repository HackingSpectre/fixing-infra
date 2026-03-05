/**
 * @module wallet/repository
 *
 * Unified façade over the domain-specific sub-repositories.
 *
 * Each aggregate root now lives in its own file under `./repository/`:
 *   1. Identity             → `identity.repository.ts`
 *   2. Wallet               → `wallet.repository.ts`
 *   3. Signer               → `signer.repository.ts`
 *   4. Address + readiness  → `address.repository.ts`
 *   5. Provisioning Job     → `provisioning-job.repository.ts`
 *   6. Gas Tank             → `gas-tank.repository.ts`
 *
 * This file re-composes them into a single `WalletRepository` class so
 * every existing consumer (server.ts, auth.service, tests) continues to
 * work without import changes.  The class delegates every method call to
 * the appropriate sub-repository — zero logic of its own.
 */

import type { DbClient } from "../../db/client";
import { IdentityRepository } from "./repository/identity.repository";
import { CoreWalletRepository } from "./repository/wallet.repository";
import { SignerRepository } from "./repository/signer.repository";
import { AddressRepository } from "./repository/address.repository";
import { ProvisioningJobRepository } from "./repository/provisioning-job.repository";
import { GasTankRepository } from "./repository/gas-tank.repository";
import type {
  Chain,
  Curve,
  Identity,
  ProvisioningJob,
  Wallet,
  WalletAddress,
  WalletSigner,
  WalletStatus,
} from "./types";

export class WalletRepository {
  private readonly identity: IdentityRepository;
  private readonly wallet: CoreWalletRepository;
  private readonly signer: SignerRepository;
  private readonly address: AddressRepository;
  private readonly provisioningJob: ProvisioningJobRepository;
  private readonly gasTank: GasTankRepository;

  constructor(db: DbClient) {
    this.identity = new IdentityRepository(db);
    this.wallet = new CoreWalletRepository(db);
    this.signer = new SignerRepository(db);
    this.address = new AddressRepository(db);
    this.provisioningJob = new ProvisioningJobRepository(db);
    this.gasTank = new GasTankRepository(db);
  }

  // -----------------------------------------------------------------------
  // 1. Identity
  // -----------------------------------------------------------------------

  upsertIdentity(providerSub: string, email: string | null): Promise<Identity> {
    return this.identity.upsertIdentity(providerSub, email);
  }

  // -----------------------------------------------------------------------
  // 2. Wallet
  // -----------------------------------------------------------------------

  findWalletByIdentity(identityId: string): Promise<Wallet | null> {
    return this.wallet.findWalletByIdentity(identityId);
  }

  getWallet(walletId: string): Promise<Wallet | null> {
    return this.wallet.getWallet(walletId);
  }

  createWallet(identityId: string): Promise<Wallet> {
    return this.wallet.createWallet(identityId);
  }

  setWalletStatus(walletId: string, status: WalletStatus): Promise<void> {
    return this.wallet.setWalletStatus(walletId, status);
  }

  // -----------------------------------------------------------------------
  // 3. Signer
  // -----------------------------------------------------------------------

  getSigner(walletId: string, curve: Curve): Promise<WalletSigner | null> {
    return this.signer.getSigner(walletId, curve);
  }

  upsertSigner(input: {
    walletId: string;
    curve: Curve;
    dwalletId: string;
    dwalletCapId: string;
    publicKeyHex: string;
    state: "pending" | "active" | "failed";
    lastErrorCode?: string;
    lastErrorMessage?: string;
  }): Promise<void> {
    return this.signer.upsertSigner(input);
  }

  // -----------------------------------------------------------------------
  // 4. Address
  // -----------------------------------------------------------------------

  upsertAddress(walletId: string, chain: Chain, address: string, sourceCurve: Curve): Promise<void> {
    return this.address.upsertAddress(walletId, chain, address, sourceCurve);
  }

  getAddresses(walletId: string): Promise<WalletAddress[]> {
    return this.address.getAddresses(walletId);
  }

  countReadyComponents(walletId: string): Promise<{ activeSigners: number; addresses: number }> {
    return this.address.countReadyComponents(walletId);
  }

  // -----------------------------------------------------------------------
  // 5. Provisioning Job
  // -----------------------------------------------------------------------

  createProvisioningJob(walletId: string, idempotencyKey: string): Promise<ProvisioningJob> {
    return this.provisioningJob.createProvisioningJob(walletId, idempotencyKey);
  }

  getLatestProvisioningJob(walletId: string): Promise<ProvisioningJob | null> {
    return this.provisioningJob.getLatestProvisioningJob(walletId);
  }

  setProvisioningStatus(
    jobId: string,
    status: ProvisioningJob["status"],
    input?: { errorCode?: string; errorMessage?: string; incrementAttempt?: boolean },
  ): Promise<void> {
    return this.provisioningJob.setProvisioningStatus(jobId, status, input);
  }

  // -----------------------------------------------------------------------
  // 6. Gas Tank
  // -----------------------------------------------------------------------

  getGasTankRow(): Promise<{ id: string; suiBalance: number; ikaBalance: number } | null> {
    return this.gasTank.getGasTankRow();
  }

  createGasTankIfMissing(initialSui?: number, initialIka?: number): Promise<void> {
    return this.gasTank.createGasTankIfMissing(initialSui, initialIka);
  }

  consumeGas(input: { sui: number; ika: number }): Promise<boolean> {
    return this.gasTank.consumeGas(input);
  }
}
