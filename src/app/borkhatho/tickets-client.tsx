"use client";

import { useMemo, useState } from "react";
import { gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";

export interface TicketRow {
  id: string;
  serial: string;
  status: string;
  farm: string;
  tin: string | null;
  plate: string | null;
  driver: string | null;
  batchNumber: number | null;
  grossG: number | null;
  tareG: number | null;
  netG: number | null;
  createdAt: string;
  weighedAt: string | null;
  paidAt: string | null;
}

const STATUSES = ["DRAFT", "OPEN", "WEIGHED", "ANALYSED", "PAID", "VOID"] as const;

/**
 * Every Борхат this season, one list. The other screens each show a slice — what still
 * needs weighing, what still needs a lab result, what still needs cash — and a ticket
 * that has moved past all of them simply stops appearing anywhere. This is where it
 * still is: search by serial, farm, TIN or plate, or narrow by status.
 */
export function TicketsClient({ tickets }: { tickets: TicketRow[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets.filter((t) => {
      if (status && t.status !== status) return false;
      if (!q) return true;
      return (
        t.serial.toLowerCase().includes(q) ||
        t.farm.toLowerCase().includes(q) ||
        (t.tin ?? "").includes(q) ||
        (t.plate ?? "").toLowerCase().includes(q) ||
        (t.driver ?? "").toLowerCase().includes(q)
      );
    });
  }, [tickets, query, status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <input
          className="input min-w-64 flex-1"
          placeholder={`${tg.common.search} — ${tg.ticket.number}, ${tg.ticket.consignor}, ${tg.ticket.tin}, ${tg.ticket.vehicleHint}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">—</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{tg.ticketStatus[s]}</option>
          ))}
        </select>
      </div>

      <p className="text-sm text-ink-faint">
        {filtered.length} × {tg.ticket.title}
      </p>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-paper-line text-start text-xs uppercase tracking-wide text-ink-faint">
              <th className="px-3 py-2 text-start">{tg.ticket.number}</th>
              <th className="px-3 py-2 text-start">{tg.ticket.consignor}</th>
              <th className="px-3 py-2 text-start">{tg.ticket.batch}</th>
              <th className="px-3 py-2 text-start">{tg.common.date}</th>
              <th className="px-3 py-2 text-end">{tg.ticket.net}</th>
              <th className="px-3 py-2 text-start">{tg.common.status}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-ink-faint">
                  {tg.common.nothingFound}
                </td>
              </tr>
            )}
            {filtered.map((t) => (
              <tr key={t.id} className="border-b border-paper-line last:border-0 hover:bg-paper">
                <td className="px-3 py-2">
                  <a href={`/borkhat/${t.id}`} className="font-mono text-brand hover:underline">
                    {t.serial}
                  </a>
                  {t.plate && <div className="text-xs text-ink-faint">{t.plate}</div>}
                </td>
                <td className="px-3 py-2">
                  <div>{t.farm}</div>
                  {t.driver && <div className="text-xs text-ink-faint">{t.driver}</div>}
                </td>
                <td className="px-3 py-2">{t.batchNumber ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-ink-faint">
                  {new Date(t.createdAt).toLocaleDateString("ru-RU")}
                </td>
                <td className="px-3 py-2 text-end tabular">
                  {t.netG !== null ? `${gramsToKgString(t.netG, 1)} ${tg.common.kg}` : "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={t.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "PAID"
      ? "bg-brand-light text-brand-dark"
      : status === "VOID"
        ? "bg-red-50 text-alarm"
        : status === "ANALYSED"
          ? "bg-amber-100 text-warn"
          : "bg-paper text-ink-soft";
  const label = (tg.ticketStatus as Record<string, string>)[status] ?? status;
  return <span className={`badge ${tone}`}>{label}</span>;
}
