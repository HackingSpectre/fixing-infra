import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";

function resolveSslMode(connectionString: string): "require" | false {
  if (env.DB_SSL_MODE === "require") {
    return "require";
  }

  if (env.DB_SSL_MODE === "disable") {
    return false;
  }

  try {
    const url = new URL(connectionString);
    const host = url.hostname.toLowerCase();
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    return isLocalHost ? false : "require";
  } catch {
    return env.NODE_ENV === "production" ? "require" : false;
  }
}

const queryClient = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
  ssl: resolveSslMode(env.DATABASE_URL),
  prepare: false,
  onnotice: () => {},
});

export const db = drizzle(queryClient);
export type DbClient = typeof db;

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
