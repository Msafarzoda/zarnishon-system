import { and, asc, eq, inArray, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { weighTickets } from "@/db/schema/index";
import { collateralFor, type Collateral } from "@/domain/lending";
import { outstandingAdvanceD } from "./balances";
import { getActiveSettings } from "./settings";

/** Anything that can run a query — the real `db`, or a transaction handle. */
type Executor = Pick<typeof db, "select" | "insert">;

/**
 * Statuses that mean "this farm's cotton is in our warehouse and we have not settled for
 * it yet". WEIGHED is through the weighbridge and waiting on the lab; ANALYSED has been
 * sampled and is payable. Both are cotton we are holding and have not paid a somoni for,
 * which is exactly what can stand behind a loan. PAID cotton is ours and the money is
 * theirs; VOID never existed; OPEN has no нетто yet, because the truck is still on the
 * scale. docs/domain.md §4.
 */
const IN_HAND = ["WEIGHED", "ANALYSED"] as const;

/** Нетто of everything this farm has in our warehouse, unsettled. Grams. */
export async function cottonInHandG(x: Executor, counterpartyId: string): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${weighTickets.netG}), 0)` })
    .from(weighTickets)
    .where(
      and(
        eq(weighTickets.consignorId, counterpartyId),
        inArray(weighTickets.status, [...IN_HAND]),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Қарзи иҷозатдодашуда — what this farm may borrow, and why that is the number.
 *
 * Every figure is recomputed from tickets and the ledger; nothing about a farm's credit
 * is stored anywhere for someone to raise by hand.
 */
export async function farmCollateral(
  counterpartyId: string,
  x: Executor = db,
): Promise<Collateral & { advanceRateDPerKg: number }> {
  const [settings, inHandG, outstanding] = await Promise.all([
    getActiveSettings(),
    cottonInHandG(x, counterpartyId),
    outstandingAdvanceD(counterpartyId, x),
  ]);

  return {
    ...collateralFor({
      cottonInHandG: inHandG,
      outstandingAdvanceD: outstanding,
      advanceRateDPerKg: settings.advanceRateDPerKg,
    }),
    advanceRateDPerKg: settings.advanceRateDPerKg,
  };
}

/**
 * The борхатҳо that could be settled for this farm today, oldest first, each carrying its
 * own approved lab deduction and the variety its price must be resolved against.
 *
 * Only ANALYSED tickets appear: a load the lab has not cleared has no deduction, so there
 * is no honest amount to pay for it. Cotton still at the lab counts as collateral but
 * cannot be sold, and the cash desk says so rather than quietly leaving it out.
 *
 * The lab subquery names its tables explicitly — interpolating a Drizzle column into a raw
 * template renders it unqualified and collides with the join.
 */
export interface SettlableTicket {
  ticketId: string;
  serial: string;
  netG: number;
  weighedAt: Date | null;
  varietyId: string | null;
  deductionBp: number;
}

export async function settlableTickets(
  counterpartyId: string,
  season: number,
  x: Executor = db,
): Promise<SettlableTicket[]> {
  const rows = await x
    .select({
      ticketId: weighTickets.id,
      serial: weighTickets.serial,
      netG: weighTickets.netG,
      weighedAt: weighTickets.weighedAt,
      varietyId: weighTickets.varietyId,
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
    .where(
      and(
        eq(weighTickets.consignorId, counterpartyId),
        eq(weighTickets.status, "ANALYSED"),
        eq(weighTickets.season, season),
      ),
    )
    .orderBy(asc(weighTickets.weighedAt));

  return rows
    .filter((r) => r.netG !== null)
    .map((r) => ({
      ticketId: r.ticketId,
      serial: r.serial,
      netG: r.netG!,
      weighedAt: r.weighedAt,
      varietyId: r.varietyId,
      deductionBp: Number(r.deductionBp ?? 0),
    }));
}
