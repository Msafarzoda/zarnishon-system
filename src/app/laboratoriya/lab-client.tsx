"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DomainError,
  bpToPercentString,
  gramsToKgString,
  percentStringToBp,
} from "@/domain/units";
import { deductionBp as computeDeduction, payableWeight } from "@/domain/weight";
import type { DeductionMode } from "@/domain/weight";
import { submit } from "@/lib/offline/station-client";
import { tg } from "@/lib/i18n/tg";

interface BatchRow {
  batchId: string;
  number: number;
  grade: number | null;
  variety: string | null;
  ticketCount: number;
  netG: number;
  analysisId: string | null;
  analysisStatus: string | null;
  moistureBp: number | null;
  trashBp: number | null;
  computedDeductionBp: number | null;
  overrideDeductionBp: number | null;
  storageNote: string | null;
}

interface Settings {
  deductionMode: DeductionMode;
  norms: { moistureBp: number; trashBp: number };
}

export function LabClient({
  season, settings, batches,
}: { season: number; settings: Settings; batches: BatchRow[] }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const waiting = batches.filter((b) => b.analysisStatus !== "APPROVED");
  const done = batches.filter((b) => b.analysisStatus === "APPROVED");

  return (
    <div className="space-y-5">
      <div className="card px-4 py-3 text-sm text-ink-soft">
        {tg.lab.deduction}:{" "}
        <strong className="text-ink">
          {settings.deductionMode === "TOTAL"
            ? `${tg.lab.moisture} + ${tg.lab.trash}`
            : `> ${bpToPercentString(settings.norms.moistureBp, 0)}% ${tg.lab.moisture} · > ${bpToPercentString(settings.norms.trashBp, 0)}% ${tg.lab.trash}`}
        </strong>
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

      {waiting.length === 0 && (
        <div className="card p-8 text-center text-ink-faint">{tg.common.nothingFound}</div>
      )}

      {waiting.map((b) => (
        <AnalysisCard key={b.batchId} batch={b} settings={settings}
                      onNotice={setNotice} onDone={() => router.refresh()} />
      ))}

      {done.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.lab.approved}</h2>
          <table className="w-full text-sm">
            <thead className="text-ink-faint">
              <tr className="text-start">
                <th className="py-1 text-start font-medium">{tg.lab.batchNo}</th>
                <th className="py-1 text-end font-medium">{tg.lab.moisture}</th>
                <th className="py-1 text-end font-medium">{tg.lab.trash}</th>
                <th className="py-1 text-end font-medium">{tg.lab.deduction}</th>
                <th className="py-1 text-end font-medium">{tg.cash.payable}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {done.map((b) => {
                const d = b.overrideDeductionBp ?? b.computedDeductionBp ?? 0;
                return (
                  <tr key={b.batchId}>
                    <td className="py-2 font-medium">{b.number}</td>
                    <td className="py-2 text-end tabular">{bpToPercentString(b.moistureBp ?? 0)}</td>
                    <td className="py-2 text-end tabular">{bpToPercentString(b.trashBp ?? 0)}</td>
                    <td className="py-2 text-end tabular font-semibold">
                      {bpToPercentString(d)}
                      {b.overrideDeductionBp !== null && (
                        <span className="ms-1 badge bg-amber-100 text-warn">{tg.lab.override}</span>
                      )}
                    </td>
                    <td className="py-2 text-end tabular">
                      {gramsToKgString(payableWeight(b.netG, d), 1)} {tg.common.kg}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function AnalysisCard({
  batch, settings, onNotice, onDone,
}: {
  batch: BatchRow; settings: Settings;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void; onDone: () => void;
}) {
  const [moisture, setMoisture] = useState(
    batch.moistureBp !== null ? bpToPercentString(batch.moistureBp) : "",
  );
  const [trash, setTrash] = useState(
    batch.trashBp !== null ? bpToPercentString(batch.trashBp) : "",
  );
  const [storage, setStorage] = useState(batch.storageNote ?? "");
  const [overriding, setOverriding] = useState(false);
  const [overrideValue, setOverrideValue] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Live preview: the technician sees the deduction and what it costs the farm in
  // kilograms before anything is committed.
  let preview: { deductionBp: number; payableG: number } | { error: string } | null = null;
  if (moisture.trim() && trash.trim()) {
    try {
      const d = computeDeduction(
        { moistureBp: percentStringToBp(moisture), trashBp: percentStringToBp(trash) },
        settings.deductionMode,
        settings.norms,
      );
      preview = { deductionBp: d, payableG: payableWeight(batch.netG, d) };
    } catch (err) {
      preview = { error: err instanceof DomainError ? err.message : tg.common.error };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || "error" in preview) return;
    setBusy(true);
    try {
      let analysisId = batch.analysisId;

      if (!analysisId || batch.analysisStatus !== "DRAFT") {
        const created = await submit<{ analysisId: string }>("/api/lab/analyses", {
          batchId: batch.batchId,
          stage: "on_intake",
          moistureBp: percentStringToBp(moisture),
          trashBp: percentStringToBp(trash),
          storageNote: storage || undefined,
          sampledAt: new Date().toISOString(),
        });
        if (created.kind !== "applied") {
          onNotice({
            tone: "bad",
            text: created.kind === "rejected" ? created.message : tg.app.offline,
          });
          return;
        }
        analysisId = created.result.analysisId;
      }

      const approved = await submit<{ ticketsPromoted: number; effectiveDeductionBp: number }>(
        "/api/lab/approve",
        {
          analysisId,
          overrideDeductionBp: overriding ? percentStringToBp(overrideValue) : undefined,
          overrideReason: overriding ? overrideReason : undefined,
        },
      );

      if (approved.kind !== "applied") {
        onNotice({
          tone: "bad",
          text: approved.kind === "rejected" ? approved.message : tg.app.offline,
        });
        return;
      }

      onNotice({
        tone: "ok",
        text: `${tg.ticket.batch} ${batch.number} — ${tg.lab.approved}. ` +
          `${tg.dashboard.unpaidTickets}: ${approved.result.ticketsPromoted}`,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-5 space-y-4">
      <header className="flex items-baseline gap-3 flex-wrap">
        <h2 className="text-lg font-semibold">
          {tg.ticket.batch} {batch.number}
        </h2>
        {batch.variety && <span className="text-ink-soft">{batch.variety}</span>}
        <span className="ms-auto tabular text-ink-soft">
          {batch.ticketCount} × {tg.ticket.title} · {gramsToKgString(batch.netG, 0)} {tg.common.kg}
        </span>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor={`m-${batch.batchId}`}>{tg.lab.moisture}</label>
          <input id={`m-${batch.batchId}`} inputMode="decimal" required autoComplete="off"
                 className="input-number" placeholder="9"
                 value={moisture} onChange={(e) => setMoisture(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`t-${batch.batchId}`}>{tg.lab.trash}</label>
          <input id={`t-${batch.batchId}`} inputMode="decimal" required autoComplete="off"
                 className="input-number" placeholder="2"
                 value={trash} onChange={(e) => setTrash(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`s-${batch.batchId}`}>{tg.lab.storage}</label>
          <input id={`s-${batch.batchId}`} className="input" placeholder={tg.lab.bunt}
                 value={storage} onChange={(e) => setStorage(e.target.value)} />
        </div>
      </div>

      {preview && (
        "error" in preview ? (
          <p className="text-alarm font-medium">{preview.error}</p>
        ) : (
          <div className="flex flex-wrap gap-6 rounded-lg bg-brand-light px-4 py-3">
            <div>
              <span className="text-sm text-brand-dark">{tg.lab.deduction}</span>
              <div className="tabular text-2xl font-bold text-brand-dark">
                {bpToPercentString(preview.deductionBp)} %
              </div>
            </div>
            <div>
              <span className="text-sm text-brand-dark">{tg.cash.payable}</span>
              <div className="tabular text-2xl font-bold text-brand-dark">
                {gramsToKgString(preview.payableG, 1)} {tg.common.kg}
              </div>
            </div>
          </div>
        )
      )}

      <div className="space-y-3 border-t border-paper-line pt-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={overriding}
                 onChange={(e) => setOverriding(e.target.checked)} />
          {tg.lab.override}
        </label>

        {overriding && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`o-${batch.batchId}`}>{tg.lab.deduction}</label>
              <input id={`o-${batch.batchId}`} inputMode="decimal" required className="input"
                     value={overrideValue} onChange={(e) => setOverrideValue(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor={`r-${batch.batchId}`}>{tg.lab.overrideReason}</label>
              <input id={`r-${batch.batchId}`} required className="input"
                     value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      <button type="submit"
              disabled={busy || !preview || "error" in preview ||
                        (overriding && (!overrideValue || !overrideReason.trim()))}
              className="btn-primary btn-lg w-full">
        {busy ? tg.common.loading : tg.lab.approve}
      </button>
      <p className="text-xs text-ink-faint">{tg.lab.alreadyApproved}</p>
    </form>
  );
}
