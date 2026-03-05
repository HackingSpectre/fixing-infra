import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";

dotenv.config();

function getConnectionString(): string {
  if (process.env.DATABASE_URL_DIRECT) return process.env.DATABASE_URL_DIRECT;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.DB_HOST || "localhost";
  const port = process.env.DB_PORT || "5432";
  const database = process.env.DB_NAME || "deta_infra";
  const user = process.env.DB_USER || "postgres";
  const password = process.env.DB_PASSWORD || "postgres";

  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: getConnectionString(),
  },
});
