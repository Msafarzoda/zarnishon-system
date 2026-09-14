"use client";

import { tg } from "@/lib/i18n/tg";

/**
 * A statement is a record, not a bearer instrument — nobody can claim money with it — so
 * unlike the Борхат and the receipt it is not counted or reprint-controlled.
 */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="btn-primary ms-auto">
      {tg.common.print}
    </button>
  );
}
