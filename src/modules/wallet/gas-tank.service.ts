import { env } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { ERROR_CODES } from "../../errors/error-codes";
import { WalletRepository } from "./repository";

export class GasTankService {
  constructor(private readonly repository: WalletRepository) {}

  async ensureInitialized(): Promise<void> {
    await this.repository.createGasTankIfMissing(1000, 1000);
  }

  async preflightAndConsumeForProvisioning(input?: { sui?: number; ika?: number }): Promise<void> {
    const suiCost = input?.sui ?? 0.02;
    const ikaCost = input?.ika ?? 0.1;

    const row = await this.repository.getGasTankRow();
    if (!row) {
      throw new AppError(ERROR_CODES.SPONSOR_BALANCE_LOW, "Gas tank is not initialized", 503);
    }

    if (row.suiBalance <= env.GAS_HARD_THRESHOLD_SUI || row.ikaBalance <= env.GAS_HARD_THRESHOLD_IKA) {
      throw new AppError(ERROR_CODES.SPONSOR_BALANCE_LOW, "Gas tank below hard threshold", 503, {
        suiBalance: row.suiBalance,
        ikaBalance: row.ikaBalance,
      });
    }

    const consumed = await this.repository.consumeGas({ sui: suiCost, ika: ikaCost });
    if (!consumed) {
      throw new AppError(ERROR_CODES.SPONSOR_BALANCE_LOW, "Insufficient sponsored gas balance", 503, {
        requiredSui: suiCost,
        requiredIka: ikaCost,
      });
    }
  }
}
