import { redirect } from "next/navigation";
import { and, desc, eq, gte, isNotNull, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  advances,
  counterparties,
  labAnalyses,
  ledgerAccounts,
  ledgerEntries,
  payments,
  users,
  weighTickets,
} from "@/db/schema/index";
import { AuthError, requireRole } from "@/lib/auth/session";
import { cashOnHandD } from "@/server/services/balances";
import { resolvePriceAt } from "@/server/services/pricing";
import { getActiveSettings } from "@/server/services/settings";
import { runAllChecks } from "@/server/services/integrity";
import { payableWeight } from "@/domain/weight";
import {
  bpToPercentString,
  diramToSomoniString,
  divRound,
  gramsToKgString,
} from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let user;
  try {
    user = await requireRole("owner", "accountant", "admin");
  } catch (err) {
    if (err instanceof AuthError && err.code === "NOT_SIGNED_IN") redirect("/vorud");
    throw err;
  }

  const season = new Date().getFullYear();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const settings = await getActiveSettings();

  let priceDPerKg: number | null = null;
  try {
    priceDPerKg = (await resolvePriceAt(new Date(), null)).priceDPerKg;
  } catch {
    priceDPerKg = null;
  }

  // ---- cotton received this season
  const [received] = await db
    .select({
      tickets: raw<string>`COUNT(*)`,
      netG: raw<string>`COALESCE(SUM(${weighTickets.netG}), 0)`,
    })
    .from(weighTickets)
    .where(
      and(
        eq(weighTickets.season, season),
        isNotNull(weighTickets.netG),
        raw`${weighTickets.status} <> 'VOID'`,
      ),
    );

  // ---- what is still owed to farmers, in cotton
  // The obligation is denominated in kilograms, not money: the price is only fixed when
  // the farmer decides to be paid. So we carry the weight and value it at today's price.
  const unpaidRows = await db
    .select({
      netG: weighTickets.netG,
      farmId: weighTickets.consignorId,
      deductionBp: raw<number>`COALESCE(${labAnalyses.overrideDeductionBp}, ${labAnalyses.computedDeductionBp})`,
    })
    .from(weighTickets)
    .innerJoin(
      labAnalyses,
      and(
        eq(labAnalyses.batchId, weighTickets.batchId),
        eq(labAnalyses.stage, "on_intake"),
        eq(labAnalyses.status, "APPROVED"),
      ),
    )
    .where(and(eq(weighTickets.status, "ANALYSED"), eq(weighTickets.season, season)));

  let unpaidPayableG = 0;
  const unpaidFarms = new Set<string>();
  for (const row of unpaidRows) {
    if (row.netG === null) continue;
    unpaidPayableG += payableWeight(row.netG, Number(row.deductionBp ?? 0));
    unpaidFarms.add(row.farmId);
  }
  const estimatedLiabilityD =
    priceDPerKg !== null ? divRound(unpaidPayableG * priceDPerKg, 1000) : null;

  // ---- cotton weighed but not yet cleared by the lab
  const [awaitingLab] = await db
    .select({
      tickets: raw<string>`COUNT(*)`,
      netG: raw<string>`COALESCE(SUM(${weighTickets.netG}), 0)`,
    })
    .from(weighTickets)
    .where(and(eq(weighTickets.status, "WEIGHED"), eq(weighTickets.season, season)));

  // ---- money
  const cashD = await cashOnHandD();

  const [advanceTotal] = await db
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.kind, "ADVANCE_RECEIVABLE"));

  const [paidToday] = await db
    .select({
      count: raw<string>`COUNT(*)`,
      cashD: raw<string>`COALESCE(SUM(${payments.cashPayableD}), 0)`,
      grossD: raw<string>`COALESCE(SUM(${payments.grossAmountD}), 0)`,
    })
    .from(payments)
    .where(gte(payments.paidAt, startOfDay));

  const [seedRevenue] = await db
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.kind, "SEED_REVENUE"));

  // ---- things the owner should look at
  const voided = await db
    .select({
      serial: weighTickets.serial,
      reason: weighTickets.voidReason,
      voidedAt: weighTickets.voidedAt,
      by: users.fullName,
    })
    .from(weighTickets)
    .leftJoin(users, eq(users.id, weighTickets.voidedBy))
    .where(and(eq(weighTickets.status, "VOID"), eq(weighTickets.season, season)))
    .orderBy(desc(weighTickets.voidedAt))
    .limit(10);

  const overrides = await db
    .select({
      batchId: labAnalyses.batchId,
      computed: labAnalyses.computedDeductionBp,
      applied: labAnalyses.overrideDeductionBp,
      reason: labAnalyses.overrideReason,
      by: users.fullName,
      at: labAnalyses.approvedAt,
    })
    .from(labAnalyses)
    .leftJoin(users, eq(users.id, labAnalyses.approvedBy))
    .where(isNotNull(labAnalyses.overrideDeductionBp))
    .orderBy(desc(labAnalyses.approvedAt))
    .limit(10);

  const advanceByFarm = await db
    .select({
      farm: counterparties.name,
      balanceD: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)`,
    })
    .from(ledgerAccounts)
    .innerJoin(counterparties, eq(counterparties.id, ledgerAccounts.counterpartyId))
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerAccounts.kind, "ADVANCE_RECEIVABLE"))
    .groupBy(counterparties.name)
    .orderBy(desc(raw`COALESCE(SUM(${ledgerEntries.amountD}), 0)`))
    .limit(10);

  // Recomputed from source rows every time this page loads: the ledger must balance,
  // each ticket's weights must match its weighing record, each payment must match what
  // the ledger actually posted, and every issued serial must have a ticket.
  const findings = await runAllChecks(season);

  const kg = (g: number) => `${gramsToKgString(g, 0)} ${tg.common.kg}`;
  const som = (d: number) => `${diramToSomoniString(d)} ${tg.common.somoni}`;

  return (
    <Shell user={user} title={`${tg.dashboard.title} — ${tg.app.season}-${season}`}>
      <div className="space-y-6">
        {findings.length > 0 && (
          <section className="card border-alarm bg-red-50 p-4">
            <h2 className="mb-3 font-semibold text-alarm">
              {tg.dashboard.massBalance} — {findings.length}
            </h2>
            <ul className="space-y-2 text-sm">
              {findings.map((f, i) => (
                <li key={i} className="flex flex-wrap gap-2">
                  <span className={f.severity === "alarm" ? "font-semibold text-alarm" : "text-warn"}>
                    {f.titleTg}
                  </span>
                  {f.reference && <span className="font-mono text-ink-soft">{f.reference}</span>}
                  <span className="w-full text-ink-soft">{f.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label={tg.dashboard.cashOnHand} value={som(cashD)} accent />
          <Tile
            label={tg.dashboard.estimatedLiability}
            value={estimatedLiabilityD !== null ? som(estimatedLiabilityD) : "—"}
            hint={
              priceDPerKg !== null
                ? `${tg.price.current} ${diramToSomoniString(priceDPerKg)} ${tg.price.perKg}`
                : tg.price.onlyOwner
            }
            tone={estimatedLiabilityD !== null && estimatedLiabilityD > cashD ? "warn" : undefined}
          />
          <Tile label={tg.dashboard.advancesOutstanding} value={som(Number(advanceTotal?.total ?? 0))} />
          <Tile
            label={tg.dashboard.paidToday}
            value={som(Number(paidToday?.cashD ?? 0))}
            hint={`${paidToday?.count ?? 0} × ${tg.ticket.title}`}
          />
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label={tg.dashboard.cottonReceived}
            value={kg(Number(received?.netG ?? 0))}
            hint={`${received?.tickets ?? 0} × ${tg.ticket.title}`}
          />
          <Tile label={tg.dashboard.cottonPayable} value={kg(unpaidPayableG)} />
          <Tile
            label={tg.dashboard.unpaidFarmers}
            value={String(unpaidFarms.size)}
            hint={`${unpaidRows.length} × ${tg.ticket.title}`}
          />
          <Tile
            label={tg.lab.title}
            value={kg(Number(awaitingLab?.netG ?? 0))}
            hint={`${awaitingLab?.tickets ?? 0} × ${tg.ticket.title} — ${tg.cash.notAnalysed}`}
            tone={Number(awaitingLab?.tickets ?? 0) > 0 ? "warn" : undefined}
          />
        </section>

        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink-soft">{tg.lab.deduction}</h2>
          <p className="text-sm">
            {settings.deductionMode === "TOTAL"
              ? `${tg.lab.moisture} + ${tg.lab.trash}`
              : `${tg.lab.moisture} > ${bpToPercentString(settings.norms.moistureBp, 0)} % · ` +
                `${tg.lab.trash} > ${bpToPercentString(settings.norms.trashBp, 0)} %`}
          </p>
          <p className="mt-1 text-xs text-ink-faint">{tg.price.paymentDayNotice}</p>
        </section>

        {Number(seedRevenue?.total ?? 0) !== 0 && (
          <section className="grid gap-4 sm:grid-cols-2">
            <Tile label={tg.dashboard.seedRevenue} value={som(-Number(seedRevenue?.total ?? 0))} />
          </section>
        )}

        {advanceByFarm.length > 0 && (
          <Panel title={tg.advance.outstanding}>
            <ul className="divide-y divide-paper-line text-sm">
              {advanceByFarm
                .filter((r) => Number(r.balanceD) > 0)
                .map((r) => (
                  <li key={r.farm} className="flex justify-between py-2">
                    <span>{r.farm}</span>
                    <span className="tabular font-semibold">{som(Number(r.balanceD))}</span>
                  </li>
                ))}
            </ul>
          </Panel>
        )}

        {(voided.length > 0 || overrides.length > 0) && (
          <Panel title={tg.dashboard.alerts} tone="warn">
            {overrides.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-sm font-medium">{tg.dashboard.labOverrides}</h3>
                <ul className="space-y-1 text-sm">
                  {overrides.map((o, i) => (
                    <li key={i} className="flex flex-wrap gap-2">
                      <span className="tabular">
                        {bpToPercentString(o.computed)} % → {bpToPercentString(o.applied ?? 0)} %
                      </span>
                      <span className="text-ink-soft">{o.reason}</span>
                      <span className="ms-auto text-ink-faint">{o.by}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {voided.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">{tg.dashboard.voidedTickets}</h3>
                <ul className="space-y-1 text-sm">
                  {voided.map((v) => (
                    <li key={v.serial} className="flex flex-wrap gap-2">
                      <span className="font-mono">{v.serial}</span>
                      <span className="text-ink-soft">{v.reason}</span>
                      <span className="ms-auto text-ink-faint">{v.by}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        )}
      </div>
    </Shell>
  );
}

function Tile({
  label, value, hint, accent, tone,
}: {
  label: string; value: string; hint?: string;
  accent?: boolean; tone?: "warn";
}) {
  return (
    <div className={`card px-4 py-4 ${accent ? "border-brand bg-brand-light" : ""}`}>
      <div className={`text-sm ${accent ? "text-brand-dark" : "text-ink-soft"}`}>{label}</div>
      <div
        className={`tabular text-2xl font-bold ${
          tone === "warn" ? "text-warn" : accent ? "text-brand-dark" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

function Panel({
  title, tone, children,
}: { title: string; tone?: "warn"; children: React.ReactNode }) {
  return (
    <section className={`card p-4 ${tone === "warn" ? "border-warn bg-amber-50/50" : ""}`}>
      <h2 className={`mb-3 text-sm font-semibold ${tone === "warn" ? "text-warn" : "text-ink-soft"}`}>
        {title}
      </h2>
      {children}
    </section>
  );
}
