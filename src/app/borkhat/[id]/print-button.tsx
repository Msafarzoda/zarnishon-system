"use client";

import { tg } from "@/lib/i18n/tg";

export function PrintButton() {
  return (
    <button onClick={() => window.print()} className="btn-primary ms-auto">
      {tg.common.print}
    </button>
  );
}
