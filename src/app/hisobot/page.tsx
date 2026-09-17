import { and, desc, eq, gte, isNotNull, isNull, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  advances,
  counterparties,
  drivers,
  vehicles,
  labAnalyses,
  ledgerAccounts,
  ledgerEntries,
  payments,
  productSales,
  productionRuns,
  runFeeds,
  users,
  weighEvents,
  weighTickets,
} from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { cashOnHandD, totalFarmPayableD } from "@/server/services/balances";
import { resolvePriceAt } from "@/server/services/pricing";
import { getActiveSettings } from "@/server/services/settings";
import { runAllChecks } from "@/server/services/integrity";
import { listReprints } from "@/server/services/printing";
import { productStock } from "@/server/services/product-sales";
import { currentProductPrices } from "@/server/services/product-pricing";
import { runMassBalance, runTotals } from "@/server/services/production";
import { totalBuyerReceivableD } from "@/server/services/balances";
import { PRODUCT_KINDS, saleAmountD, type ProductKind } from "@/domain/product";
import { tgProduct } from "@/lib/i18n/products";
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
  const user = await requirePageRole("owner", "accountant", "admin");

  const season = new Date().getFullYear();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const settings = await getActiveSettings();

  /** Recent-history window for the panels the owner reviews. */
  const since14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const since = since14;

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

  /**
   * Cotton received today — нетто, the same measure the season total uses, so the two
   * numbers are directly comparable rather than one being a weight and the other an
   * estimate. Keyed on `weighedAt` (тара taken, нетто known) rather than `createdAt`
   * (truck arrived): a truck that arrived today but is still on the scale waiting for
   * тара has not yet told us how much cotton it actually brought.
   */
  const [receivedToday] = await db
    .select({
      tickets: raw<string>`COUNT(*)`,
      netG: raw<string>`COALESCE(SUM(${weighTickets.netG}), 0)`,
    })
    .from(weighTickets)
    .where(
      and(
        gte(weighTickets.weighedAt, startOfDay),
        isNotNull(weighTickets.netG),
        raw`${weighTickets.status} <> 'VOID'`,
      ),
    );

  // Trucks that arrived today and are still on the scale — брутто known, тара not yet
  // taken. Not cotton "received" (нетто is not established), but a truck sitting here
  // unweighed all day is exactly what "how much did we get today" quietly hides if this
  // is left out, so it is shown next to the confirmed figure rather than folded into it.
  const [onScaleToday] = await db
    .select({
      tickets: raw<string>`COUNT(*)`,
      grossG: raw<string>`COALESCE(SUM(${weighTickets.grossG}), 0)`,
    })
    .from(weighTickets)
    .where(and(eq(weighTickets.status, "OPEN"), gte(weighTickets.createdAt, startOfDay)));

  // ---- what is still owed to farmers, in cotton
  // The obligation is denominated in kilograms, not money: the price is only fixed when
  // the farmer decides to be paid. So we carry the weight and value it at today's price.
  const unpaidRows = await db
    .select({
      netG: weighTickets.netG,
      farmId: weighTickets.consignorId,
      deductionBp: raw<number>`COALESCE(
        (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
           FROM lab_analyses la
          WHERE la.ticket_id = weigh_tickets.id
            AND la.stage = 'on_intake' AND la.status = 'APPROVED'
            AND la.superseded_at IS NULL
          LIMIT 1),
        (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
           FROM lab_analyses la
          WHERE la.batch_id = weigh_tickets.batch_id
            AND la.stage = 'on_intake' AND la.status = 'APPROVED'
            AND la.superseded_at IS NULL
          LIMIT 1)
      )`,
    })
    .from(weighTickets)
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

  /**
   * Cotton standing in the lab is already the factory's to pay for — the sample only
   * decides how much. Counting only lab-cleared weight showed the owner an obligation of
   * nothing while trucks were queued, so what is coming is stated next to it, priced at
   * the norm deduction as an estimate rather than pretended to be exact.
   */
  const awaitingLabG = Number(awaitingLab?.netG ?? 0);
  // No deduction is applied here: the sample has not been taken, so the only honest
  // figure is the most this cotton could cost — which is the one worth planning cash
  // against. The deduction can only reduce it.
  const pendingLiabilityD =
    priceDPerKg !== null ? divRound(awaitingLabG * priceDPerKg, 1000) : null;
  const totalLiabilityD =
    estimatedLiabilityD !== null && pendingLiabilityD !== null
      ? estimatedLiabilityD + pendingLiabilityD
      : null;

  // ---- money
  const cashD = await cashOnHandD();
  // Settled cotton the factory has not handed the cash over for. Unlike the estimate
  // below, this is not a projection: it is money owed at a price already agreed.
  const owedNowD = await totalFarmPayableD();

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

  // A weight that did not come off the indicator. The scale is wired in so this should be
  // rare; when it is not rare, something is wrong with the equipment or with someone.
  const manualWeights = await db
    .select({
      id: weighEvents.id,
      serial: weighTickets.serial,
      kind: weighEvents.kind,
      weightG: weighEvents.weightG,
      reason: weighEvents.reason,
      at: weighEvents.capturedAt,
      by: users.fullName,
    })
    .from(weighEvents)
    .innerJoin(weighTickets, eq(weighTickets.id, weighEvents.ticketId))
    .leftJoin(users, eq(users.id, weighEvents.operatorId))
    .where(and(eq(weighEvents.source, "manual"), gte(weighEvents.capturedAt, since14)))
    .orderBy(desc(weighEvents.capturedAt))
    .limit(15);

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

  // Records created at the weighbridge with a truck on the scale. The weigher is allowed
  // to add these — stopping him would push the load back onto paper — so the control is
  // that the owner sees them and can check them against reality.
  const [newFarms, newVehicles, newDrivers] = await Promise.all([
    db
      .select({ name: counterparties.name, tin: counterparties.tin, by: users.fullName,
                at: counterparties.createdAt })
      .from(counterparties)
      .leftJoin(users, eq(users.id, counterparties.createdBy))
      .where(and(isNotNull(counterparties.createdBy), gte(counterparties.createdAt, since)))
      .orderBy(desc(counterparties.createdAt))
      .limit(10),
    db
      .select({ plate: vehicles.plate, model: vehicles.model, by: users.fullName,
                at: vehicles.createdAt })
      .from(vehicles)
      .leftJoin(users, eq(users.id, vehicles.createdBy))
      .where(and(isNotNull(vehicles.createdBy), gte(vehicles.createdAt, since)))
      .orderBy(desc(vehicles.createdAt))
      .limit(10),
    db
      .select({ fullName: drivers.fullName, by: users.fullName, at: drivers.createdAt })
      .from(drivers)
      .leftJoin(users, eq(users.id, drivers.createdBy))
      .where(and(isNotNull(drivers.createdBy), gte(drivers.createdAt, since)))
      .orderBy(desc(drivers.createdAt))
      .limit(10),
  ]);

  // A total with no names behind it cannot be checked against anything. The owner needs
  // to see which farms the money actually went to.
  const paidTodayRows = await db
    .select({
      paymentId: payments.id,
      farm: counterparties.name,
      serial: weighTickets.serial,
      cashPayableD: payments.cashPayableD,
      advanceOffsetD: payments.advanceOffsetD,
      paidAt: payments.paidAt,
      cashier: users.fullName,
    })
    .from(payments)
    .innerJoin(counterparties, eq(counterparties.id, payments.counterpartyId))
    .innerJoin(weighTickets, eq(weighTickets.id, payments.ticketId))
    .leftJoin(users, eq(users.id, payments.paidBy))
    .where(and(gte(payments.paidAt, startOfDay), isNull(payments.reversedAt)))
    .orderBy(desc(payments.paidAt))
    .limit(30);

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

  // Each reprint is another stamped driver's copy that may be in circulation.
  const reprints = await listReprints();

  /*
   * §7 — the factory's own half of the season.
   *
   * The owner's page answered "what have we bought and what do we owe" and stopped at the
   * бунт. Everything past it — a hundred tonnes through the gin, two thousand bales in a
   * shed, a lorry of чигит that left unpaid — was invisible here, which meant the largest
   * asset on the site and the only unsecured debt owed *to* the factory were both things
   * the owner had to go and ask about.
   */
  const [stock, productPrices, buyersOweD] = await Promise.all([
    productStock(),
    currentProductPrices(),
    totalBuyerReceivableD(),
  ]);

  const [salesTotals] = await db
    .select({
      count: raw<string>`COUNT(*)`,
      amountD: raw<string>`COALESCE(SUM(${productSales.amountD}), 0)`,
    })
    .from(productSales)
    .where(and(eq(productSales.season, season), isNull(productSales.reversedAt)));

  const [ginned] = await db
    .select({
      weightG: raw<string>`COALESCE(SUM(${runFeeds.weightG}) FILTER (
        WHERE ${runFeeds.source} = 'primary'), 0)`,
    })
    .from(runFeeds)
    .where(isNull(runFeeds.supersedesId));

  // The most recent run, open or closed. A shift's yield going out of band is worth the
  // owner seeing the same day rather than at the end of the season.
  const [lastRun] = await db
    .select({ id: productionRuns.id, serial: productionRuns.serial })
    .from(productionRuns)
    .where(isNull(productionRuns.voidedAt))
    .orderBy(desc(productionRuns.startedAt))
    .limit(1);

  const lastBalance = lastRun ? await runMassBalance(lastRun.id) : null;
  const lastTotals = lastRun ? await runTotals(lastRun.id) : null;

  /** What is standing in the yard, valued at the owner's own current prices. */
  const unsoldWorthD = PRODUCT_KINDS.reduce((sum, product: ProductKind) => {
    const price = productPrices[product]?.priceDPerKg;
    if (!price) return sum;
    return sum + saleAmountD(Math.max(0, stock[product].weightG), price);
  }, 0);

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

        {/* Money first, and inside it cash against what is owed — that pair is the
            question the owner opens this page to answer. Cotton follows, then the
            standing settings. Unlabelled rows of equal tiles made all eight figures
            look equally urgent. */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {tg.dashboard.moneySection}
          </h2>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card border-brand bg-brand-light px-5 py-5">
              <div className="text-sm text-brand-dark">{tg.dashboard.cashOnHand}</div>
              <div className="tabular text-4xl font-bold text-brand-dark">{som(cashD)}</div>
              {totalLiabilityD !== null && (
                <div
                  className={`mt-2 text-xs font-medium ${
                    totalLiabilityD + owedNowD > cashD ? "text-warn" : "text-brand-dark"
                  }`}
                >
                  {totalLiabilityD + owedNowD > cashD
                    ? tg.dashboard.coverageShort
                    : tg.dashboard.coverage}
                </div>
              )}
            </div>

            <div className="card px-5 py-5">
              <div className="text-sm text-ink-soft">{tg.dashboard.estimatedLiability}</div>
              <div
                className={`tabular text-4xl font-bold ${
                  estimatedLiabilityD !== null && estimatedLiabilityD > cashD ? "text-warn" : ""
                }`}
              >
                {estimatedLiabilityD !== null ? som(estimatedLiabilityD) : "—"}
              </div>
              <div className="mt-1 text-xs text-ink-faint">
                {priceDPerKg !== null
                  ? `${tg.price.current} ${diramToSomoniString(priceDPerKg)} ${tg.price.perKg}`
                  : tg.price.onlyOwner}
              </div>
              {/* What the lab still has to clear is money too — it just has no sample yet. */}
              {pendingLiabilityD !== null && awaitingLabG > 0 && (
                <div className="mt-3 border-t border-paper-line pt-2 text-sm">
                  <span className="text-ink-soft">{tg.dashboard.liabilityPending}</span>{" "}
                  <span className="tabular font-semibold text-warn">
                    ≤ {som(pendingLiabilityD)}
                  </span>
                  <div className="mt-0.5 text-xs text-ink-faint">
                    {tg.dashboard.liabilityTotal}{" "}
                    <span className="tabular">{som(totalLiabilityD ?? 0)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {/* Already agreed and already owed — not an estimate at today's price. */}
            <Tile
              label={tg.cash.weOwe}
              value={som(owedNowD)}
              hint={tg.cash.settledNotPaid}
              tone={owedNowD > cashD ? "warn" : undefined}
            />
            <Tile
              label={tg.dashboard.advancesOutstanding}
              value={som(Number(advanceTotal?.total ?? 0))}
            />
            <Tile
              label={tg.dashboard.paidToday}
              value={som(Number(paidToday?.cashD ?? 0))}
              hint={`${paidToday?.count ?? 0} × ${tg.ticket.title}`}
            />
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {tg.dashboard.cottonSection}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label={tg.dashboard.cottonReceivedToday}
              value={kg(Number(receivedToday?.netG ?? 0))}
              hint={`${receivedToday?.tickets ?? 0} × ${tg.ticket.title}`}
            />
            <Tile
              label={tg.dashboard.onScaleToday}
              value={kg(Number(onScaleToday?.grossG ?? 0))}
              hint={`${onScaleToday?.tickets ?? 0} × ${tg.ticket.title}`}
              tone={Number(onScaleToday?.tickets ?? 0) > 0 ? "warn" : undefined}
            />
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
              value={kg(awaitingLabG)}
              hint={`${awaitingLab?.tickets ?? 0} × ${tg.ticket.title} — ${tg.cash.notAnalysed}`}
              tone={Number(awaitingLab?.tickets ?? 0) > 0 ? "warn" : undefined}
            />
          </div>
        </section>

        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {tg.dashboard.settingsSection}
          </h2>
          <p className="text-sm">
            <span className="text-ink-soft">{tg.lab.deduction}:</span>{" "}
            {settings.deductionMode === "TOTAL"
              ? `${tg.lab.moisture} + ${tg.lab.trash}`
              : `${tg.lab.moisture} > ${bpToPercentString(settings.norms.moistureBp, 0)} % · ` +
                `${tg.lab.trash} > ${bpToPercentString(settings.norms.trashBp, 0)} %`}
          </p>
          <p className="mt-1 text-xs text-ink-faint">{tg.price.paymentDayNotice}</p>
        </section>

        {/* Корхона — the gin, the shed and the buyers. */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {tg.dashboard.factorySection}
          </h2>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label={tg.dashboard.inGin} value={kg(Number(ginned?.weightG ?? 0))} />
            <Tile
              label={tg.dashboard.balesInStock}
              value={String(stock.kip.count)}
              hint={kg(stock.kip.weightG)}
            />
            <Tile
              label={tg.dashboard.unsoldWorth}
              value={som(unsoldWorthD)}
              hint={tg.sales.setPrices}
            />
            <Tile
              label={tg.dashboard.buyersOwe}
              value={som(buyersOweD)}
              hint={`${tg.dashboard.soldThisSeason}: ${som(Number(salesTotals?.amountD ?? 0))}`}
              tone={buyersOweD > 0 ? "warn" : undefined}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRODUCT_KINDS.filter((p) => p !== "kip").map((product: ProductKind) => (
              <Tile
                key={product}
                label={`${tgProduct[product]} — ${tg.dashboard.productStock}`}
                value={kg(Math.max(0, stock[product].weightG))}
                hint={
                  productPrices[product]
                    ? `${diramToSomoniString(productPrices[product]!.priceDPerKg)} ${tg.price.perKg}`
                    : tg.sales.noPriceYet
                }
                tone={productPrices[product] ? undefined : "warn"}
              />
            ))}
            <Tile
              label={`${tgProduct.kip} — ${tg.cash.price}`}
              value={
                productPrices.kip
                  ? diramToSomoniString(productPrices.kip.priceDPerKg)
                  : "—"
              }
              hint={productPrices.kip ? tg.price.perKg : tg.sales.noPriceYet}
              tone={productPrices.kip ? undefined : "warn"}
            />
          </div>

          {/* The mass balance is the anti-fraud control for this half of the site, so it
              belongs on the owner's page and not only on the gin floor. */}
          {lastRun && lastBalance && lastTotals && (
            <Panel
              title={`${tg.dashboard.lastRunBalance} — ${lastRun.serial}`}
              tone={lastBalance.severity === "ok" ? undefined : "warn"}
            >
              <div className="grid gap-3 sm:grid-cols-4">
                <Tile label={tg.production.feed} value={kg(lastTotals.feedG)} />
                <Tile
                  label={tgProduct.chigit}
                  value={`${(lastBalance.chigitBp / 100).toFixed(1)} %`}
                  hint={kg(lastTotals.chigitG)}
                />
                <Tile
                  label={tgProduct.kip}
                  value={`${(lastBalance.kipBp / 100).toFixed(1)} %`}
                  hint={kg(lastTotals.kipG)}
                />
                <Tile
                  label={tg.production.loss}
                  value={`${(lastBalance.lossBp / 100).toFixed(2)} %`}
                  tone={lastBalance.severity === "alarm" ? "warn" : undefined}
                />
              </div>
              {lastBalance.findings.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {lastBalance.findings.map((f) => (
                    <li key={f.code}>
                      <span
                        className={f.severity === "alarm" ? "font-semibold text-alarm" : "text-warn"}
                      >
                        {f.titleTg}
                      </span>{" "}
                      <span className="text-ink-soft">{f.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {!lastRun && (
            <p className="card px-4 py-3 text-sm text-ink-faint">{tg.dashboard.noRunsYet}</p>
          )}
        </section>

        {Number(seedRevenue?.total ?? 0) !== 0 && (
          <section className="grid gap-4 sm:grid-cols-2">
            <Tile label={tg.dashboard.seedRevenue} value={som(-Number(seedRevenue?.total ?? 0))} />
          </section>
        )}

        {paidTodayRows.length > 0 && (
          <Panel title={`${tg.dashboard.paidToday} — ${tg.cash.history}`}>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-paper-line">
                {paidTodayRows.map((r) => (
                  <tr key={r.paymentId}>
                    <td className="py-1.5 tabular text-ink-faint">
                      {r.paidAt.toLocaleTimeString("ru-RU", {
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="py-1.5 font-medium">{r.farm}</td>
                    <td className="py-1.5 font-mono text-xs text-brand">{r.serial}</td>
                    <td className="py-1.5 text-end tabular text-warn">
                      {r.advanceOffsetD > 0
                        ? `− ${diramToSomoniString(r.advanceOffsetD)}`
                        : ""}
                    </td>
                    <td className="py-1.5 text-end tabular font-semibold">
                      {diramToSomoniString(r.cashPayableD)}
                    </td>
                    <td className="py-1.5 text-end text-ink-faint">{r.cashier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
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

        {(newFarms.length > 0 || newVehicles.length > 0 || newDrivers.length > 0) && (
          <Panel title={tg.dashboard.newRecords}>
            <ul className="divide-y divide-paper-line text-sm">
              {newFarms.map((f, i) => (
                <li key={`f${i}`} className="flex flex-wrap gap-2 py-2">
                  <span className="badge bg-paper text-ink-soft">{tg.ticket.consignor}</span>
                  <span className="font-medium">{f.name}</span>
                  <span className="tabular text-ink-soft">{f.tin ?? "—"}</span>
                  <span className="ms-auto text-ink-faint">
                    {f.by} · {f.at.toLocaleDateString("ru-RU")}
                  </span>
                </li>
              ))}
              {newVehicles.map((v, i) => (
                <li key={`v${i}`} className="flex flex-wrap gap-2 py-2">
                  <span className="badge bg-paper text-ink-soft">{tg.ticket.vehicle}</span>
                  <span className="font-medium">{v.model ?? "—"}</span>
                  <span className="tabular text-ink-soft">{v.plate}</span>
                  <span className="ms-auto text-ink-faint">
                    {v.by} · {v.at.toLocaleDateString("ru-RU")}
                  </span>
                </li>
              ))}
              {newDrivers.map((d, i) => (
                <li key={`d${i}`} className="flex flex-wrap gap-2 py-2">
                  <span className="badge bg-paper text-ink-soft">{tg.ticket.driver}</span>
                  <span className="font-medium">{d.fullName}</span>
                  <span className="ms-auto text-ink-faint">
                    {d.by} · {d.at.toLocaleDateString("ru-RU")}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {(voided.length > 0 || overrides.length > 0 || reprints.length > 0 ||
          manualWeights.length > 0) && (
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
            {manualWeights.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-sm font-medium">{tg.dashboard.manualWeights}</h3>
                <ul className="space-y-1 text-sm">
                  {manualWeights.map((m) => (
                    <li key={m.id} className="flex flex-wrap gap-2">
                      <span className="font-mono">{m.serial}</span>
                      <span className="tabular">
                        {m.kind === "GROSS" ? tg.ticket.gross : tg.ticket.tare}{" "}
                        {gramsToKgString(m.weightG, 1)} {tg.common.kg}
                      </span>
                      <span className="text-ink-soft">{m.reason}</span>
                      <span className="ms-auto text-ink-faint">
                        {m.by} · {m.at.toLocaleDateString("ru-RU")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {reprints.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-sm font-medium">{tg.dashboard.reprints}</h3>
                <ul className="space-y-1 text-sm">
                  {reprints.map((r) => (
                    <li key={r.serial} className="flex flex-wrap gap-2">
                      <span className="font-mono">{r.serial}</span>
                      <span className="font-semibold text-warn">
                        {tg.ticket.printedTimes}: {r.count}
                      </span>
                      <span className="ms-auto text-ink-faint">
                        {r.by} · {r.lastAt.toLocaleDateString("ru-RU")}
                      </span>
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
