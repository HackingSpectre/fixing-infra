/**
 * @module wallet/repository/address
 *
 * Data-access for derived chain addresses and readiness checks.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../../db/client";
import { walletAddresses, walletSigners } from "../../../db/schema";
import type { Chain, Curve, WalletAddress } from "../types";

export class AddressRepository {
  constructor(private readonly db: DbClient) {}

  async upsertAddress(walletId: string, chain: Chain, address: string, sourceCurve: Curve): Promise<void> {
    await this.db
      .insert(walletAddresses)
      .values({ walletId, chain: chain as any, address, sourceCurve: sourceCurve as any })
      .onConflictDoUpdate({
        target: [walletAddresses.walletId, walletAddresses.chain],
        set: { address, sourceCurve: sourceCurve as any },
      });
  }

  async getAddresses(walletId: string): Promise<WalletAddress[]> {
    const rows = await this.db
      .select()
      .from(walletAddresses)
      .where(eq(walletAddresses.walletId, walletId));

    return rows.map((row) => ({
      id: row.id,
      walletId: row.walletId,
      chain: row.chain as Chain,
      address: row.address,
      sourceCurve: row.sourceCurve as Curve,
    }));
  }

  async countReadyComponents(walletId: string): Promise<{ activeSigners: number; addresses: number }> {
    const signerCount = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(walletSigners)
      .where(and(eq(walletSigners.walletId, walletId), eq(walletSigners.state, "active")));

    const addressCount = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(walletAddresses)
      .where(eq(walletAddresses.walletId, walletId));

    return {
      activeSigners: signerCount[0]?.count ?? 0,
      addresses: addressCount[0]?.count ?? 0,
    };
  }
}
