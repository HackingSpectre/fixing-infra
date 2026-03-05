/**
 * @module wallet/repository/wallet
 *
 * Data-access for the core wallet lifecycle (CRUD + status).
 */

import { eq, sql } from "drizzle-orm";
import type { DbClient } from "../../../db/client";
import { wallets } from "../../../db/schema";
import type { Wallet, WalletStatus } from "../types";

export class CoreWalletRepository {
  constructor(private readonly db: DbClient) {}

  async findWalletByIdentity(identityId: string): Promise<Wallet | null> {
    const rows = await this.db
      .select()
      .from(wallets)
      .where(eq(wallets.identityId, identityId))
      .limit(1);

    const row = rows[0];
    return row
      ? { id: row.id, identityId: row.identityId, status: row.status as WalletStatus }
      : null;
  }

  async getWallet(walletId: string): Promise<Wallet | null> {
    const rows = await this.db
      .select()
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .limit(1);

    const row = rows[0];
    return row
      ? { id: row.id, identityId: row.identityId, status: row.status as WalletStatus }
      : null;
  }

  async createWallet(identityId: string): Promise<Wallet> {
    const inserted = await this.db
      .insert(wallets)
      .values({ identityId, status: "creating" })
      .onConflictDoNothing({ target: wallets.identityId })
      .returning();

    if (inserted[0]) {
      return {
        id: inserted[0].id,
        identityId: inserted[0].identityId,
        status: inserted[0].status as WalletStatus,
      };
    }

    const existing = await this.findWalletByIdentity(identityId);
    if (!existing) {
      throw new Error("Wallet create conflict but wallet not found");
    }
    return existing;
  }

  async setWalletStatus(walletId: string, status: WalletStatus): Promise<void> {
    await this.db
      .update(wallets)
      .set({ status, updatedAt: sql`now()`, version: sql`${wallets.version} + 1` })
      .where(eq(wallets.id, walletId));
  }
}
