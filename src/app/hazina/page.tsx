import { and, asc, desc, eq, gte, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  batches,
  counterparties,
  disbursements,
  ledgerAccounts,
  ledgerEntries,
  payments,
  users,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { canOperate, requirePageRole } from "@/lib/auth/session";
import {
  cashOnHandD,
  totalBuyerReceivableD,
  totalFarmPayableD,
} from "@/server/services/balances";
import { getActiveSettings } from "@/server/services/settings";
import { collateralFor } from "@/domain/lending";
import { resolvePriceAt } from "@/server/services/pricing";
import { priceTrend } from "@/server/services/price-trend";
import { listExpenseCategories, recentExpenses } from "@/server/services/expenses";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { CashClient } from "./cash-client";

export const dynamic = "force-dynamic";

export default async function CashDeskPage() {
  // The owner and the accountant may read the cash desk; only the cashier pays from it.
  const user = await requirePageRole("cashier", "owner", "accountant", "admin");
  const readOnly = !canOperate(user, ["cashier"]);

  const season = new Date().getFullYear();
  const now = new Date();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Tickets the lab has cleared and nobody has been paid for yet — these are exactly the
  // farmers still holding a stamped Copy C.
  const unpaid = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      netG: weighTickets.netG,
      weighedAt: weighTickets.weighedAt,
      farmId: counterparties.id,
      farm: counterparties.name,
      tin: counterparties.tin,
      plate: vehicles.plate,
      batchNumber: batches.number,
      varietyId: weighTickets.varietyId,
      variety: varieties.code,
      // The truck's own analysis decides; a партия certificate covers one that was not
      // sampled individually. Tables are named explicitly — interpolating a Drizzle
      // column here would render it unqualified and collide inside the subqueries.
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
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .leftJoin(varieties, eq(varieties.id, weighTickets.varietyId))
    .where(and(eq(weighTickets.status, "ANALYSED"), eq(weighTickets.season, season)))
    .orderBy(asc(weighTickets.weighedAt));

  // Outstanding advance per farm, summed from the ledger — never a stored number.
  const advanceRows = await db
    .select({
      counterpartyId: ledgerAccounts.counterpartyId,
      balanceD: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)`,
    })
    .from(ledgerAccounts)
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerAccounts.kind, "ADVANCE_RECEIVABLE"))
    .groupBy(ledgerAccounts.counterpartyId);

  const advanceByFarm: Record<string, number> = {};
  for (const row of advanceRows) {
    if (row.counterpartyId) {
      advanceByFarm[row.counterpartyId] = Math.max(0, Number(row.balanceD));
    }
  }

  // Resolve the price the same way `payTicket` will — per ticket, by its variety.
  // Showing the cashier a general price while the server settles on a variety-specific
  // one would put a different number on the screen than in the ledger.
  const priceByVariety = new Map<string | null, number | null>();
  let priceError: string | null = null;
  for (const varietyId of new Set(unpaid.map((t) => t.varietyId))) {
    try {
      priceByVariety.set(varietyId, (await resolvePriceAt(now, varietyId)).priceDPerKg);
    } catch (err) {
      priceByVariety.set(varietyId, null);
      priceError ??= err instanceof Error ? err.message : tg.common.error;
    }
  }

  // The headline figure is the general quote, which is what the owner normally sets —
  // and which way it has moved, because that is what a waiting farmer is deciding on.
  const trend = await priceTrend(now);

  // Why the list is empty matters to the cashier. A load sits at the weighbridge, then
  // at the lab, and only then reaches this desk — "nothing found" on its own looks like
  // a broken screen rather than work that is still upstream.
  const [upstream] = await db
    .select({
      onScale: raw<string>`COUNT(*) FILTER (WHERE ${weighTickets.status} = 'OPEN')`,
      awaitingLab: raw<string>`COUNT(*) FILTER (WHERE ${weighTickets.status} = 'WEIGHED')`,
    })
    .from(weighTickets)
    .where(eq(weighTickets.season, season));

  // Хазина is an account of money that left the drawer: who was paid, how much, and
  // against which Борхат. Without it the cashier hands out cash all day and has no way
  // to answer "who did we pay?" — and neither does the owner.
  const since = new Date(startOfDay);
  since.setDate(since.getDate() - 7);

  const history = await db
    .select({
      paymentId: payments.id,
      invoiceNo: payments.invoiceNo,
      paidAt: payments.paidAt,
      cashPayableD: payments.cashPayableD,
      grossAmountD: payments.grossAmountD,
      advanceOffsetD: payments.advanceOffsetD,
      payableG: payments.payableG,
      reversedAt: payments.reversedAt,
      farm: counterparties.name,
      serial: weighTickets.serial,
      cashier: users.fullName,
    })
    .from(payments)
    .innerJoin(counterparties, eq(counterparties.id, payments.counterpartyId))
    .innerJoin(weighTickets, eq(weighTickets.id, payments.ticketId))
    .leftJoin(users, eq(users.id, payments.paidBy))
    .where(gte(payments.paidAt, since))
    .orderBy(desc(payments.paidAt))
    .limit(100);

  const settings = await getActiveSettings();

  /**
   * The cash desk's real subject is the farm, not the борхат. A farm delivers four or five
   * times and comes in once, months later, asking for an amount — so every farm the desk
   * might deal with is listed with the three numbers that answer it: what it has standing
   * in our warehouse, what of that the lab has cleared and can therefore be sold today,
   * and what it owes us. docs/domain.md §4.
   *
   * Tables are named explicitly inside the subqueries — interpolating a Drizzle column
   * into a raw template renders it unqualified and collides with the join.
   */
  const farmRows = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      tin: counterparties.tin,
      phone: counterparties.phone,
      /** Нетто in our warehouse, unsettled: weighed or analysed, not paid, not void. */
      inHandG: raw<string>`COALESCE((
        SELECT SUM(t.net_g) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id
          AND t.status IN ('WEIGHED', 'ANALYSED')
      ), 0)`,
      /** Of that, what the lab has cleared — the only part that can be settled today. */
      readyG: raw<string>`COALESCE((
        SELECT SUM(t.net_g) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status = 'ANALYSED'
      ), 0)`,
      readyTickets: raw<string>`COALESCE((
        SELECT COUNT(*) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status = 'ANALYSED'
      ), 0)`,
      atLabG: raw<string>`COALESCE((
        SELECT SUM(t.net_g) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status = 'WEIGHED'
      ), 0)`,
      advanceD: raw<string>`COALESCE((
        SELECT SUM(e.amount_d) FROM ledger_entries e
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'ADVANCE_RECEIVABLE' AND a.counterparty_id = counterparties.id
      ), 0)`,
      owedD: raw<string>`COALESCE((
        SELECT -SUM(e.amount_d) FROM ledger_entries e
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'FARM_PAYABLE' AND a.counterparty_id = counterparties.id
      ), 0)`,
    })
    .from(counterparties)
    .where(eq(counterparties.isActive, true))
    .orderBy(asc(counterparties.name));

  const farmList = farmRows.map((f) => {
    const inHandG = Number(f.inHandG);
    const advanceD = Math.max(0, Number(f.advanceD));
    const collateral = collateralFor({
      cottonInHandG: inHandG,
      outstandingAdvanceD: advanceD,
      advanceRateDPerKg: settings.advanceRateDPerKg,
    });
    const readyG = Number(f.readyG);
    return {
      id: f.id,
      name: f.name,
      tin: f.tin,
      phone: f.phone,
      inHandG,
      readyG,
      readyTickets: Number(f.readyTickets),
      atLabG: Number(f.atLabG),
      advanceD,
      owedD: Math.max(0, Number(f.owedD)),
      maxAdvanceD: collateral.maxAdvanceD,
      headroomD: collateral.headroomD,
      overLent: collateral.overLent,
    };
  });

  /**
   * Farms that have settled and not been paid in full — the queue of people who will come
   * back asking for money. Before the settlement/disbursement split there was no such
   * list, because a ticket was either paid entirely or not at all. docs/domain.md §4.
   *
   * FARM_PAYABLE is credit-normal, so the sum is negative when we owe; it is flipped here
   * once rather than everywhere it is read.
   */
  const owedRows = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      phone: counterparties.phone,
      owedD: raw<string>`-COALESCE(SUM(${ledgerEntries.amountD}), 0)`,
      lastPaidAt: raw<string | null>`(
        SELECT MAX(d.paid_at) FROM disbursements d
        WHERE d.counterparty_id = counterparties.id AND d.reversed_at IS NULL
      )`,
      settledAt: raw<string | null>`(
        SELECT MAX(p.paid_at) FROM payments p
        WHERE p.counterparty_id = counterparties.id AND p.reversed_at IS NULL
      )`,
    })
    .from(ledgerAccounts)
    .innerJoin(counterparties, eq(counterparties.id, ledgerAccounts.counterpartyId))
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerAccounts.kind, "FARM_PAYABLE"))
    .groupBy(counterparties.id, counterparties.name, counterparties.phone)
    .having(raw`COALESCE(SUM(${ledgerEntries.amountD}), 0) < 0`);

  // Cash that has actually left the drawer, which is a different list from settlements.
  const payouts = await db
    .select({
      id: disbursements.id,
      receiptNo: disbursements.receiptNo,
      paidAt: disbursements.paidAt,
      amountD: disbursements.amountD,
      balanceAfterD: disbursements.balanceAfterD,
      paymentId: disbursements.paymentId,
      reversedAt: disbursements.reversedAt,
      farm: counterparties.name,
      cashier: users.fullName,
    })
    .from(disbursements)
    .innerJoin(counterparties, eq(counterparties.id, disbursements.counterpartyId))
    .leftJoin(users, eq(users.id, disbursements.paidBy))
    .where(gte(disbursements.paidAt, since))
    .orderBy(desc(disbursements.paidAt))
    .limit(100);

  return (
    <Shell user={user} title={tg.cash.title}>
      {readOnly && <ReadOnlyBanner />}
      <CashClient
        readOnly={readOnly}
        cashOnHandD={await cashOnHandD()}
        totalOwedD={await totalFarmPayableD()}
        /* §7: money owed to us by buyers of чигит, улюк, пучоқ and кип. The drawer is
           one drawer — what a local pays for a lorry of seed this morning is what pays
           a farm this afternoon — so the desk has to see it coming. */
        buyersOweD={await totalBuyerReceivableD()}
        owedFarms={owedRows
          .map((f) => ({
            id: f.id,
            name: f.name,
            phone: f.phone,
            owedD: Number(f.owedD),
            lastPaidAt: f.lastPaidAt ? new Date(f.lastPaidAt).toISOString() : null,
            settledAt: f.settledAt ? new Date(f.settledAt).toISOString() : null,
          }))
          .sort((a, b) => b.owedD - a.owedD)}
        payouts={payouts.map((d) => ({
          ...d,
          paidAt: d.paidAt.toISOString(),
          reversed: d.reversedAt !== null,
        }))}
        trend={trend}
        advanceRateDPerKg={settings.advanceRateDPerKg}
        priceError={priceError}
        onScale={Number(upstream?.onScale ?? 0)}
        awaitingLab={Number(upstream?.awaitingLab ?? 0)}
        history={history.map((h) => ({ ...h, paidAt: h.paidAt.toISOString(),
                                       reversed: h.reversedAt !== null }))}
        tickets={unpaid.map((t) => ({
          ...t,
          netG: t.netG ?? 0,
          deductionBp: Number(t.deductionBp ?? 0),
          weighedAt: t.weighedAt?.toISOString() ?? null,
          advanceD: advanceByFarm[t.farmId] ?? 0,
          priceDPerKg: priceByVariety.get(t.varietyId) ?? null,
        }))}
        farms={farmList}
        expenseCategories={await listExpenseCategories()}
        recentExpenses={(await recentExpenses()).map((e) => ({
          ...e,
          occurredAt: e.occurredAt.toISOString(),
        }))}
      />
    </Shell>
  );
}
