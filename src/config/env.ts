import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project root so execution cwd does not matter.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(5050),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_DIRECT: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  DB_SSL_MODE: z.enum(["auto", "require", "disable"]).default("auto"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  QUEUE_MODE: z.enum(["inline", "redis"]).default("inline"),
  GOOGLE_CLIENT_ID: z.string().min(1),
  APP_JWT_SECRET: z.string().min(16),
  APP_JWT_EXPIRES_IN: z.string().default("1h"),
  IKA_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  IKA_SUI_RPC_URL: z.string().url(),
  IKA_SUI_RPC_URLS: z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      const entries = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return entries.length > 0 ? entries : undefined;
    },
    z.array(z.string().url()).optional(),
  ),
  IKA_SIGNER_SECRET_KEY_BASE64: z.string().min(1),
  IKA_USER_SHARE_ROOT_SEED_BASE64: z.string().min(1),
  IKA_FEE_IKA_COIN_OBJECT_ID: z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().min(1).optional(),
  ),
  IKA_FEE_IKA_COIN_TYPE: z
    .string()
    .min(1)
    .default("0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA"),
  IKA_FEE_SUI_AMOUNT_MIST: z.coerce.number().int().positive().default(1_000_000),
  IKA_ACTIVE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  IKA_ACTIVE_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  GAS_SOFT_THRESHOLD_SUI: z.coerce.number().default(10),
  GAS_SOFT_THRESHOLD_IKA: z.coerce.number().default(10),
  GAS_HARD_THRESHOLD_SUI: z.coerce.number().default(1),
  GAS_HARD_THRESHOLD_IKA: z.coerce.number().default(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const env = envSchema.parse(process.env);
