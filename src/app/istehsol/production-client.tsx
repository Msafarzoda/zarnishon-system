"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { submit } from "@/lib/offline/station-client";
import { gramsToKgString, kgStringToGrams } from "@/domain/units";
import type { MassBalance, RunTotals } from "@/domain/mass-balance";
import type { ProductKind } from "@/domain/product";
import { tgProduct } from "@/lib/i18n/products";
import { tg } from "@/lib/i18n/tg";
import { Empty, Notice, Section, Stat, TBody, Td, Th } from "@/components/ui";

interface Batch { id: string; number: number; closed: boolean }
interface Store { id: string; name: string }

interface RunView {
  id: string;
  serial: string;
  startedAt: string;
  operator: string | null;
  batchNumbers: number[];
  totals: RunTotals;
  balance: MassBalance;
  feeds: { id: string; weightG: number; source: string; fedAt: string; batchNumber: number | null }[];
  outputs: { id: string; product: string; weightG: number; recordedAt: string }[];
  bales: { id: string; serial: string; weightG: number; pressedAt: string; batchNumber: number | null }[];
}

type Job = "feed" | "output" | "bale" | null;

export function ProductionClient({
  run, batches, stores, recentRuns, readOnly,
}: {
  run: RunView | null;
  batches: Batch[];
  stores: Store[];
  recentRuns: { id: string; serial: string; startedAt: string; endedAt: string | null; operator: string | null }[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [job, setJob] = useState<Job>(null);
  const [busy, setBusy] = useState(false);

  const openable = batches.filter((b) => !b.closed);

  async function openRun() {
    setBusy(true);
    const out = await submit("/api/production/runs", { action: "open" });
    setBusy(false);
    if (out.kind === "rejected") setNotice({ tone: "bad", text: out.message });
    else router.refresh();
  }

  async function closeRun() {
    if (!run) return;
    setBusy(true);
    const out = await submit("/api/production/runs", { action: "close", runId: run.id });
    setBusy(false);
    if (out.kind === "rejected") setNotice({ tone: "bad", text: out.message });
    else { setJob(null); router.refresh(); }
  }

  if (!run) {
    return (
      <div className="space-y-5">
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        <Empty
          title={tg.production.noOpenRun}
          hint={tg.production.noOpenRunHint}
          tone="warn"
        />
        {!readOnly && (
          <button type="button" className="btn-primary" disabled={busy} onClick={openRun}>
            {tg.production.openRun}
          </button>
        )}
        <RunHistory runs={recentRuns} />
      </div>
    );
  }

  const { totals, balance } = run;

  return (
    <div className="space-y-5">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Section
        title={`${tg.production.runOpen} — ${run.serial}`}
        subtitle={
          run.batchNumbers.length > 0
            ? `${tg.ticket.batch} ${run.batchNumbers.join(", ")}`
            : tg.production.subtitle
        }
        actions={
          !readOnly && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={closeRun}>
              {tg.production.closeRun}
            </button>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat
            accent
            label={tg.production.feed}
            value={gramsToKgString(totals.feedG, 0)}
            unit={tg.common.kg}
            hint={totals.recycledG > 0
              ? `+ ${gramsToKgString(totals.recycledG, 0)} ${tg.production.feedSourceRecycled.toLowerCase()}`
              : undefined}
          />
          <Stat
            label={tgProduct.chigit}
            value={gramsToKgString(totals.chigitG, 0)}
            unit={tg.common.kg}
            hint={totals.feedG > 0 ? `${(balance.chigitBp / 100).toFixed(1)} %` : undefined}
          />
          <Stat
            label={tgProduct.kip}
            value={gramsToKgString(totals.kipG, 0)}
            unit={tg.common.kg}
            hint={`${run.bales.length} × ${tgProduct.kip}` +
              (totals.feedG > 0 ? ` · ${(balance.kipBp / 100).toFixed(1)} %` : "")}
          />
          <Stat label={tgProduct.ulyuk} value={gramsToKgString(totals.ulyukG, 0)} unit={tg.common.kg} />
          <Stat label={tgProduct.puchoq} value={gramsToKgString(totals.puchoqG, 0)} unit={tg.common.kg} />
          <Stat
            label={tg.production.loss}
            value={gramsToKgString(Math.max(0, balance.lossG), 0)}
            unit={tg.common.kg}
            hint={`${(balance.lossBp / 100).toFixed(2)} %`}
            tone={balance.severity === "alarm" ? "alarm" : balance.severity === "warn" ? "warn" : undefined}
          />
        </div>
      </Section>

      {/* The mass balance is the whole reason this screen records what goes in. Findings
          are shown where the work happens, not buried in the owner's report a week later. */}
      {balance.findings.length > 0 ? (
        <Section title={tg.production.balance} tone={balance.severity === "alarm" ? "alarm" : "warn"}>
          <ul className="space-y-2">
            {balance.findings.map((f) => (
              <li key={f.code}>
                <p className={`font-semibold ${f.severity === "alarm" ? "text-alarm" : "text-warn"}`}>
                  {f.titleTg}
                </p>
                <p className="text-sm text-ink-soft">{f.detail}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        totals.feedG > 0 && (
          <Notice tone="ok">
            {tg.production.balanceOk} — {tg.production.loss} {(balance.lossBp / 100).toFixed(2)} %
          </Notice>
        )
      )}

      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <JobButton active={job === "feed"} onClick={() => setJob(job === "feed" ? null : "feed")}>
            {tg.production.addFeed}
          </JobButton>
          <JobButton active={job === "output"} onClick={() => setJob(job === "output" ? null : "output")}>
            {tg.production.addOutput}
          </JobButton>
          <JobButton active={job === "bale"} onClick={() => setJob(job === "bale" ? null : "bale")}>
            {tg.production.pressBale}
          </JobButton>
        </div>
      )}

      {job === "feed" && (
        <FeedForm
          runId={run.id} batches={openable} stores={stores}
          onNotice={setNotice} onDone={() => router.refresh()}
        />
      )}
      {job === "output" && (
        <OutputForm
          runId={run.id} stores={stores}
          onNotice={setNotice} onDone={() => router.refresh()}
        />
      )}
      {job === "bale" && (
        <BaleForm
          runId={run.id} batches={openable} stores={stores}
          onNotice={setNotice} onDone={() => router.refresh()}
        />
      )}

      {run.bales.length > 0 && (
        <Section
          title={`${tg.production.balesPressed} — ${run.bales.length}`}
          scroll
          actions={
            <a className="btn-ghost" href="/kipho">
              {tg.bales.title} →
            </a>
          }
        >
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>{tg.bales.serial}</Th>
                <Th>{tg.ticket.batch}</Th>
                <Th align="end">{tg.common.weight}</Th>
                <Th align="end">{tg.common.time}</Th>
              </tr>
            </thead>
            <TBody>
              {run.bales.map((b) => (
                <tr key={b.id}>
                  <Td className="font-mono text-brand">{b.serial}</Td>
                  <Td>{b.batchNumber ?? "—"}</Td>
                  <Td align="end" numeric>{gramsToKgString(b.weightG, 1)}</Td>
                  <Td align="end" numeric className="text-ink-faint">
                    {new Date(b.pressedAt).toLocaleTimeString("ru-RU", {
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </Td>
                </tr>
              ))}
            </TBody>
          </table>
        </Section>
      )}

      {run.feeds.length > 0 && (
        <Section title={tg.production.feed} scroll>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>{tg.ticket.batch}</Th>
                <Th>{tg.common.source}</Th>
                <Th align="end">{tg.common.weight}</Th>
                <Th align="end">{tg.common.time}</Th>
              </tr>
            </thead>
            <TBody>
              {run.feeds.map((f) => (
                <tr key={f.id}>
                  <Td>{f.batchNumber ?? "—"}</Td>
                  <Td>
                    {f.source === "recycled"
                      ? tg.production.feedSourceRecycled
                      : tg.production.feedSourcePrimary}
                  </Td>
                  <Td align="end" numeric>{gramsToKgString(f.weightG, 0)}</Td>
                  <Td align="end" numeric className="text-ink-faint">
                    {new Date(f.fedAt).toLocaleTimeString("ru-RU", {
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </Td>
                </tr>
              ))}
            </TBody>
          </table>
        </Section>
      )}

      <RunHistory runs={recentRuns} />
    </div>
  );
}

function JobButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={active ? "btn-primary" : "btn-secondary"}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- the three forms

/**
 * Every weight on this screen is typed, because none of these things crosses the
 * weighbridge — the gin is fed by conveyor and the bale scale is mechanical. So each form
 * asks for the reason that §2 demands of any hand-entered number, and refuses without it.
 */
function WeightField({
  label, value, onChange, autoFocus,
}: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <input
          className="input tabular text-2xl"
          inputMode="decimal"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-ink-soft">{tg.common.kg}</span>
      </div>
    </label>
  );
}

function FeedForm({
  runId, batches, stores, onNotice, onDone,
}: {
  runId: string;
  batches: Batch[];
  stores: Store[];
  onNotice: (n: { tone: "ok" | "warn" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [kg, setKg] = useState("");
  const [batchId, setBatchId] = useState(batches[0]?.id ?? "");
  const [storeId, setStoreId] = useState("");
  const [source, setSource] = useState<"primary" | "recycled">("primary");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    let weightG: number;
    try {
      weightG = kgStringToGrams(kg);
    } catch {
      onNotice({ tone: "bad", text: tg.common.invalidWeight });
      return;
    }
    setBusy(true);
    const out = await submit("/api/production/feeds", {
      runId,
      weightG,
      batchId: batchId || undefined,
      storageLocationId: storeId || undefined,
      source,
      weighSource: "manual",
      reason: reason.trim(),
    });
    setBusy(false);
    if (out.kind === "rejected") onNotice({ tone: "bad", text: out.message });
    else {
      setKg("");
      onNotice({ tone: "ok", text: `${tg.production.feed}: ${kg} ${tg.common.kg}` });
      onDone();
    }
  }

  return (
    <Section title={tg.production.addFeed}>
      <div className="grid gap-4 sm:grid-cols-2">
        <WeightField label={tg.production.feed} value={kg} onChange={setKg} autoFocus />
        <label className="block">
          <span className="label">{tg.production.whichBatch}</span>
          <select className="input" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">—</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>{tg.ticket.batch} {b.number}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{tg.common.store}</span>
          <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">—</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">{tg.common.source}</span>
          <select
            className="input"
            value={source}
            onChange={(e) => setSource(e.target.value as "primary" | "recycled")}
          >
            <option value="primary">{tg.production.feedSourcePrimary}</option>
            <option value="recycled">{tg.production.feedSourceRecycled}</option>
          </select>
          {source === "recycled" && (
            <span className="mt-1 block text-xs text-ink-faint">
              {tg.production.feedSourceRecycledHint}
            </span>
          )}
        </label>
        <label className="block sm:col-span-2">
          <span className="label">{tg.production.reasonNeeded}</span>
          <input
            className="input"
            placeholder={tg.production.reasonPlaceholder}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        className="btn-primary mt-4"
        disabled={busy || !kg.trim() || !reason.trim()}
        onClick={save}
      >
        {tg.common.save}
      </button>
    </Section>
  );
}

function OutputForm({
  runId, stores, onNotice, onDone,
}: {
  runId: string;
  stores: Store[];
  onNotice: (n: { tone: "ok" | "warn" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [product, setProduct] = useState<ProductKind>("chigit");
  const [kg, setKg] = useState("");
  const [storeId, setStoreId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    let weightG: number;
    try {
      weightG = kgStringToGrams(kg);
    } catch {
      onNotice({ tone: "bad", text: tg.common.invalidWeight });
      return;
    }
    setBusy(true);
    const out = await submit("/api/production/outputs", {
      runId, product, weightG,
      storageLocationId: storeId || undefined,
      weighSource: "manual",
      reason: reason.trim(),
    });
    setBusy(false);
    if (out.kind === "rejected") onNotice({ tone: "bad", text: out.message });
    else {
      setKg("");
      onNotice({ tone: "ok", text: `${tgProduct[product]}: ${kg} ${tg.common.kg}` });
      onDone();
    }
  }

  return (
    <Section title={tg.production.addOutput}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">{tg.sales.product}</span>
          {/* Кип is absent on purpose: a bale is pressed one at a time and numbered,
              never poured onto a heap. The server refuses it too. */}
          <select
            className="input"
            value={product}
            onChange={(e) => setProduct(e.target.value as ProductKind)}
          >
            <option value="chigit">{tgProduct.chigit}</option>
            <option value="ulyuk">{tgProduct.ulyuk}</option>
            <option value="puchoq">{tgProduct.puchoq}</option>
          </select>
        </label>
        <WeightField label={tg.common.weight} value={kg} onChange={setKg} autoFocus />
        <label className="block">
          <span className="label">{tg.common.store}</span>
          <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">—</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">{tg.production.reasonNeeded}</span>
          <input
            className="input"
            placeholder={tg.production.reasonPlaceholder}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        className="btn-primary mt-4"
        disabled={busy || !kg.trim() || !reason.trim()}
        onClick={save}
      >
        {tg.common.save}
      </button>
    </Section>
  );
}

/**
 * Pressing a bale. The weight field keeps focus and the партия stays chosen between
 * bales, because these come off the press one after another — a form that reset itself
 * would have the operator re-picking партия 101 two hundred times a shift.
 */
function BaleForm({
  runId, batches, stores, onNotice, onDone,
}: {
  runId: string;
  batches: Batch[];
  stores: Store[];
  onNotice: (n: { tone: "ok" | "warn" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [kg, setKg] = useState("");
  const [batchId, setBatchId] = useState(batches[0]?.id ?? "");
  const [storeId, setStoreId] = useState("");
  const [grade, setGrade] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    let weightG: number;
    try {
      weightG = kgStringToGrams(kg);
    } catch {
      onNotice({ tone: "bad", text: tg.common.invalidWeight });
      return;
    }
    if (!batchId) {
      onNotice({ tone: "bad", text: tg.production.whichBatch });
      return;
    }
    setBusy(true);
    const out = await submit<{ serial: string }>("/api/bales", {
      runId, batchId, weightG,
      grade: grade.trim() || undefined,
      storageLocationId: storeId || undefined,
    });
    setBusy(false);
    if (out.kind === "rejected") onNotice({ tone: "bad", text: out.message });
    else {
      setKg("");
      onNotice({
        tone: "ok",
        text: out.kind === "applied"
          ? `${tgProduct.kip} ${out.result.serial} — ${kg} ${tg.common.kg}`
          : tg.app.pendingSync,
      });
      onDone();
    }
  }

  return (
    <Section title={tg.production.pressBale} subtitle={tg.bales.subtitle}>
      <div className="grid gap-4 sm:grid-cols-2">
        <WeightField label={tg.production.baleWeight} value={kg} onChange={setKg} autoFocus />
        <label className="block">
          <span className="label">{tg.production.whichBatch}</span>
          <select className="input" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">—</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>{tg.ticket.batch} {b.number}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{tg.ticket.grade}</span>
          <input className="input" value={grade} onChange={(e) => setGrade(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">{tg.common.store}</span>
          <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">—</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </div>
      <button
        type="button"
        className="btn-primary mt-4"
        disabled={busy || !kg.trim() || !batchId}
        onClick={save}
      >
        {tg.production.pressBale}
      </button>
    </Section>
  );
}

function RunHistory({
  runs,
}: { runs: { id: string; serial: string; startedAt: string; endedAt: string | null; operator: string | null }[] }) {
  if (runs.length === 0) return null;
  return (
    <Section title={tg.production.runs} scroll>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>{tg.ticket.number}</Th>
            <Th>{tg.common.started}</Th>
            <Th>{tg.common.finished}</Th>
            <Th>{tg.roles.merchandiser}</Th>
          </tr>
        </thead>
        <TBody>
          {runs.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-brand">{r.serial}</Td>
              <Td numeric className="text-ink-soft">
                {new Date(r.startedAt).toLocaleString("ru-RU", {
                  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                })}
              </Td>
              <Td numeric className="text-ink-soft">
                {r.endedAt
                  ? new Date(r.endedAt).toLocaleString("ru-RU", {
                      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                    })
                  : tg.production.runOpen}
              </Td>
              <Td>{r.operator ?? "—"}</Td>
            </tr>
          ))}
        </TBody>
      </table>
    </Section>
  );
}
