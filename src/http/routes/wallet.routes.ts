import type { FastifyInstance } from "fastify";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";
import type { AuthenticatedRequest } from "../auth-middleware";
import type { WalletRepository } from "../../modules/wallet/repository";

export async function registerWalletRoutes(
  server: FastifyInstance,
  deps: {
    walletRepository: WalletRepository;
    authenticate: (request: any, reply: any) => Promise<void>;
  },
): Promise<void> {
  server.get("/v1/wallets/me", { preHandler: deps.authenticate }, async (request, reply) => {
    const walletId = (request as AuthenticatedRequest).auth.walletId;
    const wallet = await deps.walletRepository.getWallet(walletId);
    if (!wallet) {
      throw new AppError(ERROR_CODES.WALLET_NOT_FOUND, "Wallet not found", 404);
    }

    return reply.status(200).send({
      data: {
        walletId: wallet.id,
        status: wallet.status,
      },
    });
  });

  server.get("/v1/wallets/me/addresses", { preHandler: deps.authenticate }, async (request, reply) => {
    const walletId = (request as AuthenticatedRequest).auth.walletId;
    const addresses = await deps.walletRepository.getAddresses(walletId);

    return reply.status(200).send({
      data: Object.fromEntries(addresses.map((item) => [item.chain, item.address])),
    });
  });

  server.get("/v1/wallets/me/provisioning-status", { preHandler: deps.authenticate }, async (request, reply) => {
    const walletId = (request as AuthenticatedRequest).auth.walletId;
    const job = await deps.walletRepository.getLatestProvisioningJob(walletId);

    return reply.status(200).send({
      data: {
        walletId,
        status: job?.status ?? "unknown",
        jobId: job?.id ?? null,
        idempotencyKey: job?.idempotencyKey ?? null,
      },
    });
  });
}
