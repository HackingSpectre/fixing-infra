import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";
import type { IkaAdapter } from "../ika/ika.adapter";
import type { ProvisioningQueuePort } from "../queue/provisioning.queue";
import { AddressDerivationService } from "./address-derivation.service";
import { deriveEvmAddress, deriveBitcoinAddress } from "./secp256k1-addresses";
import { GasTankService } from "./gas-tank.service";
import { WalletRepository } from "./repository";
import type { Curve } from "./types";

export class ProvisioningService {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly ikaAdapter: IkaAdapter,
    private readonly gasTankService: GasTankService,
    private readonly queue: ProvisioningQueuePort,
    private readonly addressDerivationService: AddressDerivationService,
  ) {}

  async requestProvisioning(walletId: string, idempotencyKey?: string): Promise<{ queued: boolean; jobId: string }> {
    const key = idempotencyKey ?? randomUUID();
    const wallet = await this.walletRepository.getWallet(walletId);
    if (!wallet) {
      throw new AppError(ERROR_CODES.WALLET_NOT_FOUND, "Wallet not found", 404);
    }

    if (wallet.status === "ready") {
      const latest = await this.walletRepository.getLatestProvisioningJob(walletId);
      return { queued: false, jobId: latest?.id ?? "already-ready" };
    }

    await this.walletRepository.setWalletStatus(walletId, "provisioning");
    const job = await this.walletRepository.createProvisioningJob(walletId, key);

    logger.info("provisioning_job_enqueued", {
      walletId,
      jobId: job.id,
      idempotencyKey: key,
    });

    await this.queue.enqueue({
      walletId,
      jobId: job.id,
      correlationId: randomUUID(),
    });

    return { queued: true, jobId: job.id };
  }

  async processProvisioningJob(payload: { walletId: string; jobId: string; correlationId: string }): Promise<void> {
    logger.info("provisioning_job_started", {
      walletId: payload.walletId,
      jobId: payload.jobId,
      correlationId: payload.correlationId,
    });

    await this.walletRepository.setProvisioningStatus(payload.jobId, "running", { incrementAttempt: true });

    try {
      await this.gasTankService.preflightAndConsumeForProvisioning();

      const secp256k1Result = await Promise.allSettled([
        this.provisionCurve(payload.walletId, "secp256k1", payload.correlationId),
      ]);

      const failures = secp256k1Result.filter((result) => result.status === "rejected");

      if (failures.length > 0) {
        const failureMessages = failures.map((entry) => (entry as PromiseRejectedResult).reason?.message ?? "unknown failure");
        await this.walletRepository.setWalletStatus(payload.walletId, "degraded");
        await this.walletRepository.setProvisioningStatus(payload.jobId, "partial", {
          errorCode: ERROR_CODES.IKA_TRANSIENT_NETWORK_ERROR,
          errorMessage: failureMessages.join(" | "),
        });

        logger.warn("provisioning_job_partial", {
          walletId: payload.walletId,
          jobId: payload.jobId,
          correlationId: payload.correlationId,
          failures: failureMessages,
        });
        return;
      }

      const readiness = await this.walletRepository.countReadyComponents(payload.walletId);
      if (readiness.activeSigners >= 1 && readiness.addresses >= 2) {
        await this.walletRepository.setWalletStatus(payload.walletId, "ready");
        await this.walletRepository.setProvisioningStatus(payload.jobId, "completed");
        logger.info("provisioning_job_completed", {
          walletId: payload.walletId,
          jobId: payload.jobId,
          correlationId: payload.correlationId,
          activeSigners: readiness.activeSigners,
          addresses: readiness.addresses,
        });
        return;
      }

      await this.walletRepository.setWalletStatus(payload.walletId, "degraded");
      await this.walletRepository.setProvisioningStatus(payload.jobId, "partial", {
        errorCode: ERROR_CODES.WALLET_PROVISIONING_TIMEOUT,
        errorMessage: "Provisioning completed without full readiness",
      });

      logger.warn("provisioning_job_incomplete", {
        walletId: payload.walletId,
        jobId: payload.jobId,
        correlationId: payload.correlationId,
        activeSigners: readiness.activeSigners,
        addresses: readiness.addresses,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      const cause =
        error instanceof Error && "cause" in error
          ? (error as Error & { cause?: unknown }).cause
          : undefined;
      await this.walletRepository.setWalletStatus(payload.walletId, "failed");
      await this.walletRepository.setProvisioningStatus(payload.jobId, "failed", {
        errorCode: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL_ERROR,
        errorMessage: message,
      });
      logger.error("provisioning_job_failed", {
        walletId: payload.walletId,
        jobId: payload.jobId,
        correlationId: payload.correlationId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        cause,
      });
      throw error;
    }
  }

  private async provisionCurve(walletId: string, curve: Curve, correlationId: string): Promise<void> {
    const existing = await this.walletRepository.getSigner(walletId, curve);
    if (existing?.state === "active") {
      return;
    }

    const signer = await this.ikaAdapter.provisionSigner({ walletId, curve, correlationId });

    await this.walletRepository.upsertSigner({
      walletId,
      curve,
      dwalletId: signer.dwalletId,
      dwalletCapId: signer.dwalletCapId,
      publicKeyHex: signer.publicKeyHex,
      state: "active",
    });

    const evmAddress = deriveEvmAddress(signer.publicKeyHex);
    const bitcoinAddress = deriveBitcoinAddress(signer.publicKeyHex);

    await Promise.all([
      this.walletRepository.upsertAddress(walletId, "evm", evmAddress, curve),
      this.walletRepository.upsertAddress(walletId, "bitcoin", bitcoinAddress, curve),
    ]);
  }
}
