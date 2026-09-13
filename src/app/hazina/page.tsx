import { redirect } from "next/navigation";
import { and, asc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  batches,
  counterparties,
  labAnalyses,
  ledgerAccounts,
  ledgerEntries,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { AuthError, requireRole } from "@/lib/auth/session";
import { cashOnHandD } from "@/server/services/balances";
import { resolvePriceAt } from "@/server/services/pricing";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { CashClient } from "./cash-client";

export const dynamic = "force-dynamic";

export default async function CashDeskPage() {
  let user;
  try {
    user = await requireRole("cashier");
  } catch (err) {
    if (err instanceof AuthError && err.code === "NOT_SIGNED_IN") redirect("/vorud");
    throw err;
  }

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
      deductionBp: raw<number>`COALESCE(${labAnalyses.overrideDeductionBp}, ${labAnalyses.computedDeductionBp})`,
    })
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .innerJoin(
      labAnalyses,
      and(
        eq(labAnalyses.batchId, weighTickets.batchId),
        eq(labAnalyses.stage, "on_intake"),
        eq(labAnalyses.status, "APPROVED"),
      ),
    )
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

  // The price of today — the one that will actually be applied.
  let priceDPerKg: number | null = null;
  let priceError: string | null = null;
  try {
    priceDPerKg = (await resolvePriceAt(now, null)).priceDPerKg;
  } catch (err) {
    priceError = err instanceof Error ? err.message : tg.common.error;
  }

  const farmList = await db
    .select({ id: counterparties.id, name: counterparties.name })
    .from(counterparties)
    .where(and(eq(counterparties.isActive, true)))
    .orderBy(asc(counterparties.name));

  return (
    <Shell user={user} title={tg.cash.title}>
      <CashClient
        cashOnHandD={await cashOnHandD()}
        priceDPerKg={priceDPerKg}
        priceError={priceError}
        tickets={unpaid.map((t) => ({
          ...t,
          netG: t.netG ?? 0,
          deductionBp: Number(t.deductionBp ?? 0),
          weighedAt: t.weighedAt?.toISOString() ?? null,
          advanceD: advanceByFarm[t.farmId] ?? 0,
        }))}
        farms={farmList}
      />
    </Shell>
  );
}
