/**
 * @module wallet/repository/gas-tank
 *
 * Data-access for sponsored-gas balance management.
 */

import { and, sql } from "drizzle-orm";
import type { DbClient } from "../../../db/client";
import { gasTank } from "../../../db/schema";

export class GasTankRepository {
  constructor(private readonly db: DbClient) {}

  async getGasTankRow(): Promise<{ id: string; suiBalance: number; ikaBalance: number } | null> {
    const rows = await this.db.select().from(gasTank).limit(1);
    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      suiBalance: Number(row.suiBalance),
      ikaBalance: Number(row.ikaBalance),
    };
  }

  async createGasTankIfMissing(initialSui = 0, initialIka = 0): Promise<void> {
    const row = await this.getGasTankRow();
    if (row) return;

    await this.db
      .insert(gasTank)
      .values({ suiBalance: initialSui.toString(), ikaBalance: initialIka.toString() });
  }

  async consumeGas(input: { sui: number; ika: number }): Promise<boolean> {
    const row = await this.getGasTankRow();
    if (!row) {
      await this.createGasTankIfMissing();
    }

    const updated = await this.db
      .update(gasTank)
      .set({
        suiBalance: sql`${gasTank.suiBalance} - ${input.sui}`,
        ikaBalance: sql`${gasTank.ikaBalance} - ${input.ika}`,
        updatedAt: sql`now()`,
        version: sql`${gasTank.version} + 1`,
      })
      .where(and(
        sql`${gasTank.suiBalance} >= ${input.sui}`,
        sql`${gasTank.ikaBalance} >= ${input.ika}`,
      ))
      .returning({ id: gasTank.id });

    return updated.length > 0;
  }
}
