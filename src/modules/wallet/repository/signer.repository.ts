/**
 * @module wallet/repository/signer
 *
 * Data-access for IKA dWallet signer records.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../../db/client";
import { walletSigners } from "../../../db/schema";
import { withDbRetry } from "../db-retry";
import type { Curve, WalletSigner } from "../types";

export class SignerRepository {
  constructor(private readonly db: DbClient) {}

  async getSigner(walletId: string, curve: Curve): Promise<WalletSigner | null> {
    const rows = await withDbRetry(() =>
      this.db
        .select()
        .from(walletSigners)
        .where(and(eq(walletSigners.walletId, walletId), eq(walletSigners.curve, curve as any)))
        .limit(1),
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      walletId: row.walletId,
      curve: row.curve as Curve,
      dwalletId: row.dwalletId,
      dwalletCapId: row.dwalletCapId,
      publicKeyHex: row.publicKeyHex,
      state: row.state,
    };
  }

  async upsertSigner(input: {
    walletId: string;
    curve: Curve;
    dwalletId: string;
    dwalletCapId: string;
    publicKeyHex: string;
    state: "pending" | "active" | "failed";
    lastErrorCode?: string;
    lastErrorMessage?: string;
  }): Promise<void> {
    await this.db
      .insert(walletSigners)
      .values({
        walletId: input.walletId,
        curve: input.curve as any,
        dwalletId: input.dwalletId,
        dwalletCapId: input.dwalletCapId,
        publicKeyHex: input.publicKeyHex,
        state: input.state,
        lastErrorCode: input.lastErrorCode,
        lastErrorMessage: input.lastErrorMessage,
      })
      .onConflictDoUpdate({
        target: [walletSigners.walletId, walletSigners.curve],
        set: {
          dwalletId: input.dwalletId,
          dwalletCapId: input.dwalletCapId,
          publicKeyHex: input.publicKeyHex,
          state: input.state,
          lastErrorCode: input.lastErrorCode,
          lastErrorMessage: input.lastErrorMessage,
          updatedAt: sql`now()`,
        },
      });
  }
}
