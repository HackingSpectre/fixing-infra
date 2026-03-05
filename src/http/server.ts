import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { db } from "../db/client";
import { AppError } from "../errors/app-error";
import { ERROR_CODES } from "../errors/error-codes";
import { AuthService } from "../modules/auth/auth.service";
import { GoogleTokenVerifier } from "../modules/auth/google-verifier";
import { SessionService } from "../modules/auth/session.service";
import { SdkIkaAdapter } from "../modules/ika/sdk-ika.adapter";
import { createProvisioningQueue } from "../modules/queue/provisioning.queue";
import { AddressDerivationService } from "../modules/wallet/address-derivation.service";
import { GasTankService } from "../modules/wallet/gas-tank.service";
import { ProvisioningService } from "../modules/wallet/provisioning.service";
import { WalletRepository } from "../modules/wallet/repository";
import { createAuthMiddleware } from "./auth-middleware";
import { registerAuthRoutes } from "./routes/auth.routes";
import { registerDevRoutes } from "./routes/dev.routes";
import { registerWalletRoutes } from "./routes/wallet.routes";

export interface AppContext {
  server: FastifyInstance;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function createServer(): Promise<AppContext> {
  const server = Fastify({
    logger: false,
    bodyLimit: 1024 * 64,
  });

  const walletRepository = new WalletRepository(db);
  const gasTankService = new GasTankService(walletRepository);
  const queue = createProvisioningQueue();
  const ikaAdapter = new SdkIkaAdapter();
  const addressDerivationService = new AddressDerivationService();
  const provisioningService = new ProvisioningService(
    walletRepository,
    ikaAdapter,
    gasTankService,
    queue,
    addressDerivationService,
  );
  const googleTokenVerifier = new GoogleTokenVerifier();
  const sessionService = new SessionService();
  const authService = new AuthService(googleTokenVerifier, walletRepository, sessionService, provisioningService);
  const authenticate = createAuthMiddleware(sessionService);

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Invalid request payload",
          details: error.flatten(),
        },
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    const cause =
      error instanceof Error && "cause" in error
        ? (error as Error & { cause?: unknown }).cause
        : undefined;

    logger.error("unhandled_error", {
      requestId: _request.id,
      method: _request.method,
      path: _request.url,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause:
        cause && typeof cause === "object"
          ? {
              message: "message" in cause ? (cause as { message?: unknown }).message : undefined,
              code: "code" in cause ? (cause as { code?: unknown }).code : undefined,
              detail: "detail" in cause ? (cause as { detail?: unknown }).detail : undefined,
              hint: "hint" in cause ? (cause as { hint?: unknown }).hint : undefined,
            }
          : cause,
    });

    return reply.status(500).send({
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: "Internal server error",
      },
    });
  });

  await server.register(helmet);
  await server.register(cors, {
    origin: true,
    credentials: true,
  });
  await server.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  server.get("/healthz", async () => ({
    status: "ok",
    queueMode: env.QUEUE_MODE,
    ikaNetwork: env.IKA_NETWORK,
  }));

  await registerAuthRoutes(server, { authService });
  await registerWalletRoutes(server, { walletRepository, authenticate });
  await registerDevRoutes(server, { walletRepository, sessionService, provisioningService });

  await gasTankService.ensureInitialized();
  await queue.start(async (payload) => {
    await provisioningService.processProvisioningJob(payload);
  });

  return {
    server,
    start: async () => {
      await server.listen({
        host: "0.0.0.0",
        port: env.PORT,
      });
      logger.info("server_started", {
        port: env.PORT,
        queueMode: env.QUEUE_MODE,
      });
    },
    stop: async () => {
      await queue.stop();
      await server.close();
    },
  };
}
