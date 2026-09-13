import { and, asc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  batches,
  counterparties,
  ledgerAccounts,
  ledgerEntries,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { cashOnHandD } from "@/server/services/balances";
import { resolvePriceAt } from "@/server/services/pricing";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { CashClient } from "./cash-client";

export const dynamic = "force-dynamic";

export default async function CashDeskPage() {
  const user = await requirePageRole("cashier");

  const season = new Date().getFullYear();
  const now = new Date();

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

  // The headline figure is the general quote, which is what the owner normally sets.
  let generalPriceDPerKg: number | null = null;
  try {
    generalPriceDPerKg = (await resolvePriceAt(now, null)).priceDPerKg;
  } catch {
    generalPriceDPerKg = null;
  }

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

  const farmList = await db
    .select({ id: counterparties.id, name: counterparties.name })
    .from(counterparties)
    .where(and(eq(counterparties.isActive, true)))
    .orderBy(asc(counterparties.name));

  return (
    <Shell user={user} title={tg.cash.title}>
      <CashClient
        cashOnHandD={await cashOnHandD()}
        generalPriceDPerKg={generalPriceDPerKg}
        priceError={priceError}
        onScale={Number(upstream?.onScale ?? 0)}
        awaitingLab={Number(upstream?.awaitingLab ?? 0)}
        tickets={unpaid.map((t) => ({
          ...t,
          netG: t.netG ?? 0,
          deductionBp: Number(t.deductionBp ?? 0),
          weighedAt: t.weighedAt?.toISOString() ?? null,
          advanceD: advanceByFarm[t.farmId] ?? 0,
          priceDPerKg: priceByVariety.get(t.varietyId) ?? null,
        }))}
        farms={farmList}
      />
    </Shell>
  );
}
