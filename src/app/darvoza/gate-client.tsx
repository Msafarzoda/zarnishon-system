"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { gramsToKgString } from "@/domain/units";
import { submit } from "@/lib/offline/station-client";
import { tg } from "@/lib/i18n/tg";

interface GateTicket {
  id: string;
  serial: string;
  gate: string;
  grossG: number | null;
  tareG: number | null;
  createdAt: string;
  farm: string;
  plate: string | null;
  model: string | null;
  driver: string | null;
  batchNumber: number | null;
}

export function GateClient({
  onSite, departedTodayCount,
}: { onSite: GateTicket[]; departedTodayCount: number }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // Three distinct states, not overlapping sets:
  //   ARRIVED       — through the gate, not yet on the weighbridge
  //   WEIGHED_GROSS — loaded weight taken; unloading, then waiting to be weighed empty
  //   WEIGHED_TARE  — empty weight taken; free to leave
  const awaitingGross = onSite.filter((t) => t.gate === "ARRIVED");
  const awaitingTare = onSite.filter((t) => t.gate === "WEIGHED_GROSS");
  const readyToLeave = onSite.filter((t) => t.tareG !== null);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label={tg.gate.onSite} value={onSite.length} big />
        <Stat label={tg.gate.arrive} value={awaitingGross.length} />
        <Stat label={tg.gate.unloading} value={awaitingTare.length} />
        <Stat label={`${tg.gate.departed} · ${tg.gate.todayTotal}`} value={departedTodayCount} />
      </div>

      {notice && (
        <div role="status"
             className={`card px-4 py-3 ${
               notice.tone === "ok"
                 ? "border-brand bg-brand-light text-brand-dark"
                 : "border-alarm bg-red-50 text-alarm"
             }`}>
          {notice.text}
        </div>
      )}

      {onSite.length === 0 ? (
        <div className="card p-8 text-center text-ink-faint">{tg.gate.onSite}: 0</div>
      ) : (
        <ul className="space-y-2">
          {onSite.map((t) => (
            <GateRow
              key={t.id}
              ticket={t}
              canLeave={readyToLeave.some((r) => r.id === t.id)}
              onNotice={setNotice}
              onDone={() => router.refresh()}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-sm text-ink-soft">{label}</div>
      <div className={`tabular font-bold ${big ? "text-4xl text-brand" : "text-3xl"}`}>{value}</div>
    </div>
  );
}

function GateRow({
  ticket, canLeave, onNotice, onDone,
}: {
  ticket: GateTicket;
  canLeave: boolean;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function depart() {
    setBusy(true);
    try {
      const res = await submit("/api/gate", { ticketId: ticket.id });
      if (res.kind === "rejected") {
        onNotice({ tone: "bad", text: res.message });
        return;
      }
      if (res.kind === "queued") {
        onNotice({ tone: "bad", text: `${tg.app.offline} — ${tg.gate.depart}` });
        return;
      }
      onNotice({ tone: "ok", text: `${ticket.serial} — ${tg.gate.departed}` });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const arrived = new Date(ticket.createdAt).toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit",
  });

  return (
    <li className="card flex items-center gap-3 px-4 py-3 flex-wrap">
      <span className="font-mono text-brand">{ticket.serial}</span>
      <span className="font-medium">{ticket.farm}</span>
      {ticket.plate && <span className="text-ink-faint text-sm">{ticket.plate}</span>}
      {ticket.driver && <span className="text-ink-faint text-sm">{ticket.driver}</span>}
      {ticket.batchNumber !== null && (
        <span className="badge bg-paper text-ink-soft">
          {tg.ticket.batch} {ticket.batchNumber}
        </span>
      )}
      <span className="text-sm text-ink-faint">{arrived}</span>

      <span className="ms-auto tabular text-sm text-ink-soft">
        {ticket.grossG !== null && `${tg.ticket.gross} ${gramsToKgString(ticket.grossG, 0)}`}
        {ticket.tareG !== null && ` · ${tg.ticket.tare} ${gramsToKgString(ticket.tareG, 0)}`}
      </span>

      {canLeave ? (
        <button onClick={depart} disabled={busy} className="btn-primary">
          {busy ? tg.common.loading : tg.gate.depart}
        </button>
      ) : (
        <span className="badge bg-amber-100 text-warn">{tg.gate.awaitingTare}</span>
      )}
    </li>
  );
}
