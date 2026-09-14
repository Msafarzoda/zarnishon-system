"use client";

import { useState } from "react";
import { submit } from "@/lib/offline/station-client";
import { tg } from "@/lib/i18n/tg";

/** Same rule as the Борхат: every print recorded, a reprint needs a reason. */
export function PrintButton({
  paymentId,
  alreadyPrinted,
}: {
  paymentId: string;
  alreadyPrinted: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function doPrint() {
    setBusy(true);
    try {
      await submit("/api/prints", {
        paymentId,
        kind: "pardokht",
        reason: reason.trim() || undefined,
      });
    } finally {
      setBusy(false);
      setConfirming(false);
      setReason("");
      window.print();
    }
  }

  if (alreadyPrinted > 0 && confirming) {
    return (
      <div className="ms-auto flex flex-col items-end gap-2">
        <p className="text-sm text-warn">{tg.ticket.reprintWarning}</p>
        <div className="flex gap-2">
          <input className="input w-64" placeholder={tg.ticket.reprintReason}
                 value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <button onClick={() => setConfirming(false)} className="btn-secondary">
            {tg.common.cancel}
          </button>
          <button onClick={doPrint} disabled={busy || !reason.trim()} className="btn-danger">
            {busy ? tg.common.loading : tg.common.print}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => (alreadyPrinted > 0 ? setConfirming(true) : doPrint())}
      disabled={busy}
      className={`ms-auto ${alreadyPrinted > 0 ? "btn-danger" : "btn-primary"}`}
    >
      {busy ? tg.common.loading : tg.common.print}
      {alreadyPrinted > 0 && <span className="ms-1">({alreadyPrinted})</span>}
    </button>
  );
}
