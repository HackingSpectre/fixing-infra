import { createServer } from "./http/server";
import { logger } from "./config/logger";

async function bootstrap(): Promise<void> {
  const app = await createServer();

  process.on("SIGINT", async () => {
    await app.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await app.stop();
    process.exit(0);
  });

  await app.start();
}

bootstrap().catch((error) => {
  logger.error("bootstrap_failed", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
