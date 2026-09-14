"use client";

import { useMemo, useState } from "react";
import { diramToSomoniString, gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { AddForms } from "./add-forms";

export interface FarmRow {
  id: string;
  name: string;
  tin: string | null;
  place: string | null;
  phone: string | null;
  deliveredG: number;
  paidD: number;
  unpaidTickets: number;
  unpaidPayableG: number;
  unpaidValueD: number | null;
  advanceD: number;
}

/**
 * The customer list.
 *
 * Two questions are asked of this page: find one farm among many, and see who is owed
 * cotton money or owes us an advance without opening anything. So it leads with the
 * season's totals, then a search, then one line per farm with the money right-aligned so
 * a column can be scanned. Adding records is a secondary action and sits in the header —
 * most farms are created at the weighbridge with a truck already on the scale.
 */
export function FarmsClient({
  farms, vehicles, drivers,
}: {
  farms: FarmRow[];
  vehicles: { id: string; plate: string; model: string | null; transportOrg: string | null }[];
  drivers: { id: string; fullName: string; phone: string | null }[];
}) {
  const [query, setQuery] = useState("");
  const [showReference, setShowReference] = useState(false);

  const totals = useMemo(
    () =>
      farms.reduce(
        (acc, f) => ({
          deliveredG: acc.deliveredG + f.deliveredG,
          unpaidPayableG: acc.unpaidPayableG + f.unpaidPayableG,
          unpaidValueD: acc.unpaidValueD + (f.unpaidValueD ?? 0),
          advanceD: acc.advanceD + f.advanceD,
        }),
        { deliveredG: 0, unpaidPayableG: 0, unpaidValueD: 0, advanceD: 0 },
      ),
    [farms],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? farms.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            (f.tin ?? "").includes(q) ||
            (f.phone ?? "").includes(q) ||
            (f.place ?? "").toLowerCase().includes(q),
        )
      : farms;

    // Farms with something outstanding first — those are the ones anybody is looking for.
    return [...matched].sort((a, b) => {
      const weight = (f: FarmRow) => (f.advanceD > 0 ? 2 : 0) + (f.unpaidPayableG > 0 ? 1 : 0);
      return weight(b) - weight(a) || a.name.localeCompare(b.name);
    });
  }, [farms, query]);

  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={tg.account.totalFarms} value={String(farms.length)} />
        <Stat
          label={tg.dashboard.cottonReceived}
          value={`${gramsToKgString(totals.deliveredG, 0)} ${tg.common.kg}`}
        />
        <Stat
          label={tg.account.owedWeight}
          value={`${gramsToKgString(totals.unpaidPayableG, 0)} ${tg.common.kg}`}
          hint={
            totals.unpaidPayableG > 0
              ? `≈ ${diramToSomoniString(totals.unpaidValueD)} ${tg.common.somoni}`
              : undefined
          }
          accent={totals.unpaidPayableG > 0}
        />
        <Stat
          label={tg.account.totalAdvances}
          value={`${diramToSomoniString(totals.advanceD)} ${tg.common.somoni}`}
          tone={totals.advanceD > 0 ? "warn" : undefined}
        />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-56 flex-1"
          placeholder={tg.account.searchFarms}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <AddForms />
      </div>

      {filtered.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-ink-faint">
            {farms.length === 0 ? tg.account.noFarmsYet : tg.account.noMatch}
          </p>
          {farms.length === 0 && (
            <p className="mt-2 text-sm text-ink-soft">{tg.account.noFarmsHint}</p>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((f) => (
            <li key={f.id}>
              <a
                href={`/khojagiho/${f.id}`}
                className="card flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 transition-colors hover:border-brand/40 hover:bg-paper"
              >
                <div className="min-w-48 flex-1">
                  <div className="font-semibold">{f.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-faint">
                    {f.tin && <span className="tabular">{tg.ticket.tin} {f.tin}</span>}
                    {f.place && <span>{f.place}</span>}
                    {f.phone && <span className="tabular">{f.phone}</span>}
                  </div>
                </div>

                <Figure
                  label={tg.dashboard.cottonReceived}
                  value={`${gramsToKgString(f.deliveredG, 0)} ${tg.common.kg}`}
                />
                <Figure
                  label={tg.account.paidTotal}
                  value={f.paidD > 0 ? diramToSomoniString(f.paidD) : "—"}
                />
                {/* What we owe them: weight the lab cleared that is still unpaid. */}
                <Figure
                  label={tg.account.owedWeight}
                  value={
                    f.unpaidPayableG > 0
                      ? `${gramsToKgString(f.unpaidPayableG, 0)} ${tg.common.kg}`
                      : "—"
                  }
                  note={
                    f.unpaidValueD && f.unpaidPayableG > 0
                      ? `≈ ${diramToSomoniString(f.unpaidValueD)}`
                      : undefined
                  }
                  tone={f.unpaidPayableG > 0 ? "brand" : undefined}
                />
                {/* What they owe us. */}
                <Figure
                  label={tg.advance.outstanding}
                  value={f.advanceD > 0 ? diramToSomoniString(f.advanceD) : "—"}
                  note={f.advanceD > 0 ? tg.account.owesUs : undefined}
                  tone={f.advanceD > 0 ? "warn" : undefined}
                />
              </a>
            </li>
          ))}
        </ul>
      )}

      {/* Reference data, not customers — kept out of the way but reachable. */}
      <section className="card p-4">
        <button
          type="button"
          onClick={() => setShowReference((v) => !v)}
          className="flex w-full items-baseline justify-between gap-3 text-start"
        >
          <span>
            <span className="text-sm font-semibold text-ink-soft">{tg.account.reference}</span>
            <span className="ms-2 text-xs text-ink-faint">
              {vehicles.length} · {drivers.length}
            </span>
          </span>
          <span className="text-sm text-brand">{showReference ? "−" : "+"}</span>
        </button>

        {showReference && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                {tg.ticket.vehicle}
              </h3>
              <ul className="divide-y divide-paper-line text-sm">
                {vehicles.map((v) => (
                  <li key={v.id} className="flex items-baseline gap-2 py-1.5">
                    <span>{v.model ?? "—"}</span>
                    {v.transportOrg && (
                      <span className="text-xs text-ink-faint">{v.transportOrg}</span>
                    )}
                    <span className="ms-auto tabular text-ink-soft">{v.plate}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                {tg.ticket.driver}
              </h3>
              <ul className="divide-y divide-paper-line text-sm">
                {drivers.map((d) => (
                  <li key={d.id} className="flex items-baseline gap-2 py-1.5">
                    <span>{d.fullName}</span>
                    {d.phone && <span className="ms-auto tabular text-ink-soft">{d.phone}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-ink-faint sm:col-span-2">{tg.account.referenceHint}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label, value, hint, accent, tone,
}: { label: string; value: string; hint?: string; accent?: boolean; tone?: "warn" }) {
  return (
    <div className={`card px-4 py-3 ${accent ? "border-brand bg-brand-light" : ""}`}>
      <div className={`text-sm ${accent ? "text-brand-dark" : "text-ink-soft"}`}>{label}</div>
      <div
        className={`tabular text-2xl font-bold leading-tight ${
          tone === "warn" ? "text-warn" : accent ? "text-brand-dark" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

/** One right-aligned figure on a farm row, so the columns can be read down the page. */
function Figure({
  label, value, note, tone,
}: { label: string; value: string; note?: string; tone?: "warn" | "brand" }) {
  return (
    <div className="min-w-28 text-end">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div
        className={`tabular font-semibold ${
          tone === "warn" ? "text-warn" : tone === "brand" ? "text-brand" : "text-ink"
        }`}
      >
        {value}
      </div>
      {note && <div className="text-[11px] text-ink-faint">{note}</div>}
    </div>
  );
}
