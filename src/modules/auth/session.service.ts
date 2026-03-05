import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";

interface SessionPayload {
  walletId: string;
  providerSub: string;
}

  export class SessionService {
    sign(input: SessionPayload): string {
      const expiresIn = env.APP_JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"];
      return jwt.sign(input, env.APP_JWT_SECRET, {
        expiresIn,
        subject: input.walletId,
      issuer: "deta-infra",
      audience: "deta-client",
    });
  }

  verify(token: string): SessionPayload {
    try {
      const decoded = jwt.verify(token, env.APP_JWT_SECRET, {
        issuer: "deta-infra",
        audience: "deta-client",
      }) as SessionPayload;

      if (!decoded.walletId || !decoded.providerSub) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, "Invalid session payload", 401);
      }
      return decoded;
    } catch {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, "Invalid session token", 401);
    }
  }
}
