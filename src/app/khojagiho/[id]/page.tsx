import { notFound } from "next/navigation";
import { requirePageRole } from "@/lib/auth/session";
import { diramToSomoniString, gramsToKgString } from "@/domain/units";
import { farmStatement } from "@/server/services/farm-statement";
import { priceTrend } from "@/server/services/price-trend";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { PriceTrendStat } from "@/components/price-trend";
import { FarmStatementTable } from "@/components/farm-statement-table";

export const dynamic = "force-dynamic";

/**
 * Ҳисоби хоҷагӣ — one customer's whole account.
 *
 * The four questions asked at the desk, in order: how much cotton have we had from them,
 * how much of it have we paid for, how much is still owed, and what do they owe us in
 * advances. Then the statement itself — every delivery, every advance and every payment
 * on one timeline, each payment showing the price that was actually applied that day.
 */
export default async function FarmAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageRole(
    "cashier", "accountant", "owner", "merchandiser", "admin",
  );
  const { id } = await params;

  const trend = await priceTrend();
  const s = await farmStatement(id, trend.currentD);
  if (!s) notFound();

  const kg = (g: number) => `${gramsToKgString(g, 1)} ${tg.common.kg}`;
  const som = (d: number) => `${diramToSomoniString(d)} ${tg.common.somoni}`;

  return (
    <Shell
      user={user}
      title={`${tg.nav.account} — ${s.farm.name}`}
      actions={
        <a href={`/khojagiho/${id}/chop`} className="btn-secondary">
          {tg.account.printStatement}
        </a>
      }
    >
      <div className="space-y-5">
        <section className="card px-4 py-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-ink-soft">
            {s.farm.tin && (
              <span>
                {tg.ticket.tin}: <strong className="tabular text-ink">{s.farm.tin}</strong>
              </span>
            )}
            {s.farm.place && (
              <span>
                {tg.ticket.loadingPlace}: <strong className="text-ink">{s.farm.place}</strong>
              </span>
            )}
            {s.farm.phone && (
              <span>
                {tg.common.phone}:{" "}
                <a href={`tel:${s.farm.phone}`} className="font-medium text-brand hover:underline">
                  {s.farm.phone}
                </a>
              </span>
            )}
          </div>
        </section>

        {/* What the farm is holding out for, when it still has cotton unpaid. */}
        {s.unpaidPayableG > 0 && (
          <section className="grid gap-4 sm:grid-cols-2">
            <PriceTrendStat trend={trend} />
            <div className="card border-brand bg-brand-light px-4 py-3">
              <div className="text-sm text-brand-dark">{tg.cash.worthToday}</div>
              <div className="tabular text-2xl font-bold leading-tight text-brand-dark">
                {s.unpaidValueD !== null ? som(s.unpaidValueD) : "—"}
              </div>
              <div className="mt-1 text-xs text-brand-dark/70">
                {kg(s.unpaidPayableG)} · {tg.cash.waitingByChoice}
              </div>
            </div>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Tile
            label={tg.account.delivered}
            value={kg(s.deliveredG)}
            hint={
              s.pendingG > 0
                ? `${tg.account.pendingWeight}: ${kg(s.pendingG)} — ${tg.account.pendingHint}`
                : undefined
            }
          />
          <Tile label={tg.account.cashPaid} value={som(s.cashPaidD)}
                hint={`${tg.account.grossPaid}: ${som(s.grossPaidD)}`} />
          {/* Settled at an agreed price and not yet handed over — a debt, not an estimate.
              The tile beside it values cotton that has not been settled at all. */}
          <Tile
            label={tg.account.owedToFarm}
            value={som(s.owedToFarmD)}
            hint={s.owedToFarmD > 0 ? tg.cash.settledNotPaid : undefined}
            tone={s.owedToFarmD > 0 ? "warn" : undefined}
          />
          <Tile
            label={tg.account.owedWeight}
            value={kg(s.unpaidPayableG)}
            hint={s.unpaidValueD !== null ? `≈ ${som(s.unpaidValueD)}` : undefined}
            accent={s.unpaidPayableG > 0}
          />
          <Tile
            label={tg.account.advanceOutstanding}
            value={som(s.advanceOutstandingD)}
            hint={
              s.advancesIssuedD > 0
                ? `${tg.account.advancesIssued}: ${som(s.advancesIssuedD)} · ` +
                  `${tg.account.advanceRecovered}: ${som(s.advanceRecoveredD)}`
                : undefined
            }
            tone={s.advanceOutstandingD > 0 ? "warn" : undefined}
          />
        </section>

        <p className="text-xs text-ink-faint">{tg.account.valuedAtToday}</p>

        <section className="card overflow-x-auto p-4 sm:p-5">
          <header className="mb-3">
            <h2 className="text-sm font-semibold text-ink-soft">{tg.account.statement}</h2>
            <p className="mt-0.5 text-xs text-ink-faint">{tg.account.statementHint}</p>
          </header>
          <FarmStatementTable rows={s.rows} />
        </section>
      </div>
    </Shell>
  );
}

function Tile({
  label, value, hint, accent, tone,
}: { label: string; value: string; hint?: string; accent?: boolean; tone?: "warn" }) {
  return (
    <div className={`card px-4 py-3 ${accent ? "border-brand bg-brand-light" : ""}`}>
      <div className={`text-sm ${accent ? "text-brand-dark" : "text-ink-soft"}`}>{label}</div>
      <div
        className={`tabular text-xl font-bold leading-tight ${
          tone === "warn" ? "text-warn" : accent ? "text-brand-dark" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}
