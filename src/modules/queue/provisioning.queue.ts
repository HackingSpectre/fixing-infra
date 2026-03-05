import { Queue, Worker } from "bullmq";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

export interface ProvisioningJobPayload {
  walletId: string;
  jobId: string;
  correlationId: string;
}

export interface ProvisioningQueuePort {
  enqueue(payload: ProvisioningJobPayload): Promise<void>;
  start(handler: (payload: ProvisioningJobPayload) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export class InlineProvisioningQueue implements ProvisioningQueuePort {
  private handler: ((payload: ProvisioningJobPayload) => Promise<void>) | null = null;

  async enqueue(payload: ProvisioningJobPayload): Promise<void> {
    if (!this.handler) {
      throw new Error("Inline queue handler not started");
    }
    queueMicrotask(() => {
      this.handler?.(payload).catch((error) => {
        const cause =
          error instanceof Error && "cause" in error
            ? (error as Error & { cause?: unknown }).cause
            : undefined;
        logger.error("inline_queue_job_failed", {
          walletId: payload.walletId,
          jobId: payload.jobId,
          correlationId: payload.correlationId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          cause,
        });
      });
    });
  }

  async start(handler: (payload: ProvisioningJobPayload) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }
}

export class RedisProvisioningQueue implements ProvisioningQueuePort {
  private readonly queueName = "wallet-provisioning";
  private readonly connection = {
    url: env.REDIS_URL,
    maxRetriesPerRequest: null,
  };
  private readonly queue = new Queue<ProvisioningJobPayload, void, string>(this.queueName, {
    connection: this.connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: true,
      removeOnFail: 1000,
    },
  });
  private worker: Worker<ProvisioningJobPayload, void, string> | null = null;

  async enqueue(payload: ProvisioningJobPayload): Promise<void> {
    await this.queue.add("provision", payload, {
      jobId: payload.jobId,
    });
  }

  async start(handler: (payload: ProvisioningJobPayload) => Promise<void>): Promise<void> {
    this.worker = new Worker<ProvisioningJobPayload, void, string>(
      this.queueName,
      async (job) => {
        await handler(job.data);
      },
      {
        connection: this.connection,
        concurrency: 100,
      },
    );
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

export function createProvisioningQueue(): ProvisioningQueuePort {
  if (env.QUEUE_MODE === "redis") {
    return new RedisProvisioningQueue();
  }
  return new InlineProvisioningQueue();
}
