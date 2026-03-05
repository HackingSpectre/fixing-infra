import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { AuthService } from "../../modules/auth/auth.service";
import type { SessionService } from "../../modules/auth/session.service";
import type { ProvisioningService } from "../../modules/wallet/provisioning.service";
import type { WalletRepository } from "../../modules/wallet/repository";

/**
 * Development-only routes that bypass Google OAuth.
 *
 * Registered ONLY when NODE_ENV !== "production".
 * Allows a developer to trigger wallet creation + provisioning
 * without needing a valid Google ID token.
 */
export async function registerDevRoutes(
  server: FastifyInstance,
  deps: {
    walletRepository: WalletRepository;
    sessionService: SessionService;
    provisioningService: ProvisioningService;
  },
): Promise<void> {
  if (env.NODE_ENV === "production") {
    logger.warn("dev_routes_skipped", { reason: "NODE_ENV is production" });
    return;
  }

  logger.info("dev_routes_registered", {
    message: "⚠️  Dev bypass routes active — do NOT use in production",
  });

  /**
   * POST /v1/dev/create-wallet
   *
   * Creates a fake identity + wallet and triggers provisioning.
   * Returns a valid sessionToken so the caller can poll status
   * using the normal wallet endpoints.
   */
  server.post("/v1/dev/create-wallet", async (request, reply) => {
    const devSub = `dev-${randomUUID()}`;
    const devEmail = `${devSub}@dev.local`;

    logger.info("dev_create_wallet_start", { devSub, devEmail });

    // 1. Create identity
    const identity = await deps.walletRepository.upsertIdentity(devSub, devEmail);

    // 2. Create wallet
    const wallet = await deps.walletRepository.createWallet(identity.id);

    // 3. Sign a session token
    const sessionToken = deps.sessionService.sign({
      walletId: wallet.id,
      providerSub: devSub,
    });

    // 4. Trigger provisioning
    const idempotencyKey = randomUUID();
    const provisioning = await deps.provisioningService.requestProvisioning(wallet.id, idempotencyKey);

    logger.info("dev_create_wallet_done", {
      walletId: wallet.id,
      identityId: identity.id,
      provisioningQueued: provisioning.queued,
    });

    return reply.status(200).send({
      data: {
        walletId: wallet.id,
        identityId: identity.id,
        status: wallet.status,
        sessionToken,
        provisioningQueued: provisioning.queued,
        addresses: {},
        _dev: true,
      },
    });
  });
}
