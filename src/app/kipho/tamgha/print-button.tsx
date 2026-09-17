"use client";

import { tg } from "@/lib/i18n/tg";

export function LabelPrintButton() {
  return (
    <button type="button" className="btn-primary" onClick={() => window.print()}>
      {tg.common.print}
    </button>
  );
}
