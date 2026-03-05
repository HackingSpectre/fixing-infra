/**
 * @module wallet/repository/identity
 *
 * Data-access for the OAuth provider identity aggregate.
 */

import { eq, sql } from "drizzle-orm";
import type { DbClient } from "../../../db/client";
import { identities } from "../../../db/schema";
import type { Identity } from "../types";

const PROVIDER = "google" as const;

export class IdentityRepository {
  constructor(private readonly db: DbClient) {}

  async upsertIdentity(providerSub: string, email: string | null): Promise<Identity> {
    const inserted = await this.db
      .insert(identities)
      .values({ provider: PROVIDER, providerSub, email })
      .onConflictDoUpdate({
        target: [identities.provider, identities.providerSub],
        set: { email: email ?? undefined, updatedAt: sql`now()` },
      })
      .returning();

    const row = inserted[0];
    return {
      id: row.id,
      provider: PROVIDER,
      providerSub: row.providerSub,
      email: row.email,
    };
  }
}
