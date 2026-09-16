import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { factorySettings } from "@/db/schema/index";
import type { DeductionMode, DeductionNorms } from "@/domain/weight";

export interface ActiveSettings {
  deductionMode: DeductionMode;
  norms: DeductionNorms;
  massBalanceToleranceBp: number;
  /** Diram a farm may borrow per kg of cotton in hand. docs/domain.md §4. */
  advanceRateDPerKg: number;
}

/** The live settings are simply the most recently inserted row — nothing is updated. */
export async function getActiveSettings(): Promise<ActiveSettings> {
  const [row] = await db
    .select()
    .from(factorySettings)
    .orderBy(desc(factorySettings.effectiveFrom))
    .limit(1);

  if (!row) {
    throw new Error(
      "Танзимоти корхона муқаррар нашудааст. / Factory settings have never been set — run the seed.",
    );
  }
  return {
    deductionMode: row.deductionMode as DeductionMode,
    norms: { moistureBp: row.normMoistureBp, trashBp: row.normTrashBp },
    massBalanceToleranceBp: row.massBalanceToleranceBp,
    advanceRateDPerKg: row.advanceRateDPerKg,
  };
}
