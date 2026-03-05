import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors/app-error";
import { ERROR_CODES } from "../errors/error-codes";
import { SessionService } from "../modules/auth/session.service";

export interface AuthenticatedRequest extends FastifyRequest {
  auth: {
    walletId: string;
    providerSub: string;
  };
}

export function createAuthMiddleware(sessionService: SessionService) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, "Missing bearer token", 401);
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const payload = sessionService.verify(token);

    (request as AuthenticatedRequest).auth = {
      walletId: payload.walletId,
      providerSub: payload.providerSub,
    };
  };
}
