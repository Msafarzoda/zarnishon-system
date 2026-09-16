"use client";

import { useEffect, useState } from "react";
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
import { Stat } from "@/components/ui";

export interface LabRow {
  ticketId: string;
  serial: string;
  netG: number;
  weighedAt: string | null;
  status: string;
  farm: string;
  plate: string | null;
  model: string | null;
  driver: string | null;
  batchNumber: number | null;
  variety: string | null;
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
  settings, waiting, recent, readOnly,
}: { settings: Settings; waiting: LabRow[]; recent: LabRow[]; readOnly?: boolean }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  return (
    <div className="space-y-5">
      <div className="card px-4 py-3 text-sm text-ink-soft">
        {tg.lab.deduction}:{" "}
        <strong className="text-ink">
          {settings.deductionMode === "TOTAL"
            ? `${tg.lab.moisture} + ${tg.lab.trash}`
            : `> ${bpToPercentString(settings.norms.moistureBp, 0)}% ${tg.lab.moisture} · > ${bpToPercentString(settings.norms.trashBp, 0)}% ${tg.lab.trash}`}
        </strong>
        <span className="ms-3 text-ink-faint">{tg.lab.perTruck}</span>
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

      {/* What the bench needs before touching anything: how many trucks are standing,
          how much cotton that is, and how much has already gone through today. */}
      <section className="grid gap-4 sm:grid-cols-3">
        <Stat
          label={tg.lab.awaiting}
          value={String(waiting.length)}
          accent={waiting.length > 0}
        />
        <Stat
          label={tg.lab.queueWeight}
          value={`${gramsToKgString(waiting.reduce((n, r) => n + r.netG, 0), 0)} ${tg.common.kg}`}
        />
        <Stat label={tg.lab.doneToday} value={String(recent.length)} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">
          {tg.lab.awaiting} — {waiting.length}
        </h2>
        {waiting.length === 0 ? (
          <div className="card p-8 text-center text-ink-faint">{tg.common.nothingFound}</div>
        ) : (
          <div className="space-y-4">
            {waiting.map((row) => (
              <AnalysisCard key={row.ticketId} row={row} settings={settings}
                            readOnly={readOnly}
                            onNotice={setNotice} onDone={() => router.refresh()} />
            ))}
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section className="card overflow-x-auto p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.lab.approved}</h2>
          <table className="w-full text-sm">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1 text-start font-medium">{tg.ticket.number}</th>
                <th className="py-1 text-start font-medium">{tg.ticket.consignor}</th>
                <th className="py-1 text-end font-medium">{tg.ticket.net}</th>
                <th className="py-1 text-end font-medium">{tg.lab.moisture}</th>
                <th className="py-1 text-end font-medium">{tg.lab.trash}</th>
                <th className="py-1 text-end font-medium">{tg.lab.deduction}</th>
                <th className="py-1 text-end font-medium">{tg.cash.payable}</th>
                <th className="py-1 text-end font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {recent.map((r) => {
                const d = r.overrideDeductionBp ?? r.computedDeductionBp ?? 0;
                return (
                  <tr key={r.ticketId}>
                    <td className="py-2 font-mono text-brand">{r.serial}</td>
                    <td className="py-2">{r.farm}</td>
                    <td className="py-2 text-end tabular">{gramsToKgString(r.netG, 1)}</td>
                    <td className="py-2 text-end tabular">{bpToPercentString(r.moistureBp ?? 0)}</td>
                    <td className="py-2 text-end tabular">{bpToPercentString(r.trashBp ?? 0)}</td>
                    <td className="py-2 text-end tabular font-semibold">
                      {bpToPercentString(d)}
                      {r.overrideDeductionBp !== null && (
                        <span className="ms-1 badge bg-amber-100 text-warn">{tg.lab.override}</span>
                      )}
                    </td>
                    <td className="py-2 text-end tabular">
                      {gramsToKgString(payableWeight(r.netG, d), 1)} {tg.common.kg}
                    </td>
                    <td className="py-2 text-end">
                      <a href={`/tahlil/${r.ticketId}`} className="text-brand hover:underline">
                        {tg.common.print}
                      </a>
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
  row, settings, readOnly, onNotice, onDone,
}: {
  row: LabRow; settings: Settings; readOnly?: boolean;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void; onDone: () => void;
}) {
  const [moisture, setMoisture] = useState(
    row.moistureBp !== null ? bpToPercentString(row.moistureBp) : "",
  );
  const [trash, setTrash] = useState(
    row.trashBp !== null ? bpToPercentString(row.trashBp) : "",
  );
  const [storage, setStorage] = useState(row.storageNote ?? "");
  const [analysedBy, setAnalysedBy] = useState("");
  const [overriding, setOverriding] = useState(false);
  const [overrideValue, setOverrideValue] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Live preview: the technician sees the deduction and what it costs this farmer in
  // kilograms before anything is committed.
  let preview: { deductionBp: number; payableG: number } | { error: string } | null = null;
  if (moisture.trim() && trash.trim()) {
    try {
      const d = computeDeduction(
        { moistureBp: percentStringToBp(moisture), trashBp: percentStringToBp(trash) },
        settings.deductionMode,
        settings.norms,
      );
      preview = { deductionBp: d, payableG: payableWeight(row.netG, d) };
    } catch (err) {
      preview = { error: err instanceof DomainError ? err.message : tg.common.error };
    }
  }

  /**
   * What will actually be written, which is not the computed figure once the technician
   * overrides it. Showing only the computed number while sending a different one is how
   * an override slips past both the technician and anyone reading over their shoulder,
   * so the preview follows the override and states the difference in kilograms.
   */
  let applied: { deductionBp: number; payableG: number } | null = null;
  if (preview && !("error" in preview)) {
    let bp = preview.deductionBp;
    if (overriding && overrideValue.trim()) {
      try {
        bp = percentStringToBp(overrideValue);
      } catch {
        bp = preview.deductionBp;
      }
    }
    applied = { deductionBp: bp, payableG: payableWeight(row.netG, bp) };
  }
  const overridden =
    applied !== null && preview !== null && !("error" in preview) &&
    applied.deductionBp !== preview.deductionBp;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || "error" in preview) return;
    setBusy(true);
    try {
      let analysisId = row.analysisId;

      if (!analysisId || row.analysisStatus !== "DRAFT") {
        const created = await submit<{ analysisId: string }>("/api/lab/analyses", {
          ticketId: row.ticketId,
          stage: "on_intake",
          moistureBp: percentStringToBp(moisture),
          trashBp: percentStringToBp(trash),
          storageNote: storage || undefined,
          analysedBy: analysedBy || undefined,
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

      const approved = await submit<{ effectiveDeductionBp: number }>("/api/lab/approve", {
        analysisId,
        overrideDeductionBp: overriding ? percentStringToBp(overrideValue) : undefined,
        overrideReason: overriding ? overrideReason : undefined,
      });

      if (approved.kind !== "applied") {
        onNotice({
          tone: "bad",
          text: approved.kind === "rejected" ? approved.message : tg.app.offline,
        });
        return;
      }

      onNotice({
        tone: "ok",
        text: `${row.serial} — ${tg.lab.approved}. ${tg.lab.printCertificate}`,
      });
      // The lab keeps a paper certificate for every truck.
      window.open(`/tahlil/${row.ticketId}`, "_blank");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-5 space-y-4">
      <header className="flex items-baseline gap-3 flex-wrap">
        <span className="font-mono text-brand">{row.serial}</span>
        <h3 className="text-lg font-semibold">{row.farm}</h3>
        {row.plate && <span className="text-sm text-ink-faint">{row.plate}</span>}
        {row.driver && <span className="text-sm text-ink-faint">{row.driver}</span>}
        {row.batchNumber !== null && (
          <span className="badge bg-paper text-ink-soft">
            {tg.ticket.batch} {row.batchNumber}
          </span>
        )}
        {row.weighedAt && <WaitingFor since={row.weighedAt} />}
        <span className="ms-auto tabular font-semibold">
          {tg.ticket.net} {gramsToKgString(row.netG, 1)} {tg.common.kg}
        </span>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor={`m-${row.ticketId}`}>{tg.lab.moisture}</label>
          <input id={`m-${row.ticketId}`} inputMode="decimal" required autoComplete="off"
                 className="input-number" placeholder="9"
                 readOnly={readOnly}
                 value={moisture} onChange={(e) => setMoisture(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`t-${row.ticketId}`}>{tg.lab.trash}</label>
          <input id={`t-${row.ticketId}`} inputMode="decimal" required autoComplete="off"
                 className="input-number" placeholder="2"
                 readOnly={readOnly}
                 value={trash} onChange={(e) => setTrash(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`s-${row.ticketId}`}>{tg.lab.storage}</label>
          <input id={`s-${row.ticketId}`} className="input" placeholder={tg.lab.bunt}
                 readOnly={readOnly}
                 value={storage} onChange={(e) => setStorage(e.target.value)} />
        </div>
        {/* The лаборант works on paper and somebody else types it in; without this the
            record would read as though the person at the keyboard took the sample. */}
        <div>
          <label className="label" htmlFor={`by-${row.ticketId}`}>{tg.lab.analysedBy}</label>
          <input id={`by-${row.ticketId}`} className="input" readOnly={readOnly}
                 value={analysedBy} onChange={(e) => setAnalysedBy(e.target.value)} />
          <p className="mt-1 text-xs text-ink-faint">{tg.lab.analysedByHint}</p>
        </div>
      </div>

      {preview && "error" in preview && (
        <p className="text-alarm font-medium">{preview.error}</p>
      )}

      {applied && preview && !("error" in preview) && (
        <div
          className={`flex flex-wrap gap-6 rounded-lg px-4 py-3 ${
            overridden ? "border border-warn bg-amber-50" : "bg-brand-light"
          }`}
        >
          <div>
            <span className={`text-sm ${overridden ? "text-warn" : "text-brand-dark"}`}>
              {tg.lab.deduction}
            </span>
            <div
              className={`tabular text-2xl font-bold ${
                overridden ? "text-warn" : "text-brand-dark"
              }`}
            >
              {bpToPercentString(applied.deductionBp)} %
            </div>
            {overridden && (
              <div className="text-xs text-ink-faint">
                {tg.lab.computedWas} {bpToPercentString(preview.deductionBp)} %
              </div>
            )}
          </div>
          <div>
            <span className={`text-sm ${overridden ? "text-warn" : "text-brand-dark"}`}>
              {tg.cash.payable}
            </span>
            <div
              className={`tabular text-2xl font-bold ${
                overridden ? "text-warn" : "text-brand-dark"
              }`}
            >
              {gramsToKgString(applied.payableG, 1)} {tg.common.kg}
            </div>
          </div>
          {overridden && (
            <div>
              <span className="text-sm text-warn">{tg.lab.difference}</span>
              <div className="tabular text-2xl font-bold text-warn">
                {applied.payableG >= preview.payableG ? "+" : "−"}
                {gramsToKgString(Math.abs(applied.payableG - preview.payableG), 1)}{" "}
                {tg.common.kg}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Overriding the deduction is the one place in the lab where a person can move a
          farmer's weight by hand, so it is opened deliberately, warned about in words,
          and its effect is shown above in kilograms before it is approved. */}
      {!readOnly && (
        <div className="space-y-3 border-t border-paper-line pt-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={overriding}
                   onChange={(e) => setOverriding(e.target.checked)} />
            {tg.lab.override}
          </label>

          {overriding && (
            <div className="space-y-3 rounded-lg border border-warn bg-amber-50 p-3">
              <p className="text-xs text-warn">{tg.lab.overrideWarning}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor={`o-${row.ticketId}`}>{tg.lab.deduction}</label>
                  <input id={`o-${row.ticketId}`} inputMode="decimal" required
                         className="input-number"
                         value={overrideValue} onChange={(e) => setOverrideValue(e.target.value)} />
                </div>
                <div>
                  <label className="label" htmlFor={`r-${row.ticketId}`}>
                    {tg.lab.overrideReason}
                  </label>
                  <input id={`r-${row.ticketId}`} required className="input"
                         value={overrideReason}
                         onChange={(e) => setOverrideReason(e.target.value)} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {!readOnly && (
        <button type="submit"
                disabled={busy || !applied ||
                          (overriding && (!overrideValue.trim() || !overrideReason.trim()))}
                className="btn-primary btn-lg w-full">
          {busy ? tg.common.loading : `${tg.lab.approve} — ${tg.common.print}`}
        </button>
      )}
      <p className="text-xs text-ink-faint">{tg.lab.alreadyApproved}</p>
    </form>
  );
}

/**
 * How long this truck has been standing since the weighbridge finished with it. A farmer
 * waiting on a sample has no way to ask, so the bench is shown instead.
 */
function WaitingFor({ since }: { since: string }) {
  // Measured in the browser, after mounting: the server renders this HTML at one moment
  // and the browser hydrates it at another, and a clock that disagrees across the two
  // makes React discard the render.
  const [hours, setHours] = useState<number | null>(null);
  useEffect(() => {
    setHours(Math.floor((Date.now() - new Date(since).getTime()) / 3_600_000));
  }, [since]);

  if (hours === null || hours < 1) return null;
  return (
    <span className={`badge ${hours >= 4 ? "bg-amber-100 text-warn" : "bg-paper text-ink-soft"}`}>
      {hours} {tg.lab.waitingHours}
    </span>
  );
}
