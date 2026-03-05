/**
 * @module wallet/repository/provisioning-job
 *
 * Data-access for idempotent provisioning job tracking.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../../db/client";
import { provisioningJobs } from "../../../db/schema";
import { withDbRetry } from "../db-retry";
import type { ProvisioningJob } from "../types";

export class ProvisioningJobRepository {
  constructor(private readonly db: DbClient) {}

  async createProvisioningJob(walletId: string, idempotencyKey: string): Promise<ProvisioningJob> {
    const inserted = await this.db
      .insert(provisioningJobs)
      .values({ walletId, idempotencyKey, status: "queued" })
      .onConflictDoNothing({ target: [provisioningJobs.walletId, provisioningJobs.idempotencyKey] })
      .returning();

    if (inserted[0]) {
      return inserted[0] as ProvisioningJob;
    }

    const existing = await this.db
      .select()
      .from(provisioningJobs)
      .where(and(eq(provisioningJobs.walletId, walletId), eq(provisioningJobs.idempotencyKey, idempotencyKey)))
      .limit(1);

    return existing[0] as ProvisioningJob;
  }

  async getLatestProvisioningJob(walletId: string): Promise<ProvisioningJob | null> {
    const rows = await withDbRetry(() =>
      this.db
        .select()
        .from(provisioningJobs)
        .where(eq(provisioningJobs.walletId, walletId))
        .orderBy(desc(provisioningJobs.createdAt))
        .limit(1),
    );

    return (rows[0] as ProvisioningJob | undefined) ?? null;
  }

  async setProvisioningStatus(
    jobId: string,
    status: ProvisioningJob["status"],
    input?: { errorCode?: string; errorMessage?: string; incrementAttempt?: boolean },
  ): Promise<void> {
    await this.db
      .update(provisioningJobs)
      .set({
        status,
        lastErrorCode: input?.errorCode,
        lastErrorMessage: input?.errorMessage,
        updatedAt: sql`now()`,
        attemptCount: input?.incrementAttempt ? sql`${provisioningJobs.attemptCount} + 1` : undefined,
      })
      .where(eq(provisioningJobs.id, jobId));
  }
}
