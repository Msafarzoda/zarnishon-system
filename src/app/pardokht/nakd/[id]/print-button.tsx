"use client";

import { tg } from "@/lib/i18n/tg";

/**
 * No reprint counter here, unlike the Борхат and the settlement receipt: an instalment
 * receipt is not a claim on anything — the claim is the farm's balance in the ledger —
 * so a second copy costs nothing and refusing one only wastes the cashier's time.
 */
export function PlainPrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="ms-auto btn-primary">
      {tg.common.print}
    </button>
  );
}
