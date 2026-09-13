"use client";

import { useState } from "react";
import { submit } from "@/lib/offline/station-client";
import { tg } from "@/lib/i18n/tg";

/**
 * Printing a Борхат is recorded before the print dialog opens.
 *
 * The driver's copy is stamped and is what he exchanges for cash, so a second print
 * means a second claim on the same cotton could be walking around. Software cannot stop
 * anyone pressing Ctrl+P — so instead every print is logged, a reprint has to be
 * explained, and the owner sees it. See src/server/services/printing.ts.
 */
export function PrintButton({
  ticketId,
  alreadyPrinted,
}: {
  ticketId: string;
  alreadyPrinted: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function doPrint() {
    setBusy(true);
    try {
      await submit("/api/prints", { ticketId, reason: reason.trim() || undefined });
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
          <input
            className="input w-64"
            placeholder={tg.ticket.reprintReason}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
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
