import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string | null;
}

export class GoogleTokenVerifier {
  async verify(idToken: string): Promise<VerifiedGoogleIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
        audience: env.GOOGLE_CLIENT_ID,
      });

      if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
        throw new AppError(ERROR_CODES.AUTH_INVALID_TOKEN, "Invalid token issuer", 401);
      }

      if (!payload.sub) {
        throw new AppError(ERROR_CODES.AUTH_INVALID_TOKEN, "Token sub is missing", 401);
      }

      return {
        sub: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(ERROR_CODES.AUTH_INVALID_TOKEN, "Google token verification failed", 401);
    }
  }
}
