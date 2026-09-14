import { and, desc, eq, ne, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  advances,
  batches,
  counterparties,
  payments,
  users,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { divRound } from "@/domain/units";
import { payableWeight } from "@/domain/weight";
import { outstandingAdvanceD } from "./balances";

/**
 * Ҳисоби хоҷагӣ — one farm's account, as a statement.
 *
 * A farm is a customer across a whole season: it brings load after load, borrows against
 * them to pay its pickers, and is paid for each load whenever it decides the price is
 * right. Three separate things therefore move at different times — cotton in, cash out
 * as an advance, and cash out as payment — and the only way to answer "what do we owe
 * them and what do they owe us" is to put all three on one timeline in date order.
 *
 * Every row carries what was actually applied at the time: the deduction the lab found,
 * the price in force on the day of payment, and how much of the advance that payment
 * recovered. Those are read back from the frozen values on the payment, not recomputed —
 * a settled payment is history and must not change when the price does.
 */

export type StatementKind = "delivery" | "advance" | "payment";

export interface StatementRow {
  kind: StatementKind;
  at: Date;
  /** Борхат serial for a delivery or payment; empty for an advance. */
  serial: string | null;
  ticketId: string | null;
  paymentId: string | null;
  note: string | null;

  /** Cotton delivered, grams. */
  netG: number | null;
  /** Weight actually paid for, grams. */
  payableG: number | null;
  deductionBp: number | null;

  /** Price applied, diram per kg — only on a payment. */
  priceDPerKg: number | null;
  /** What the cotton came to before the advance was recovered. */
  grossAmountD: number | null;
  /** Recovered from the farm's advance on this payment. */
  advanceOffsetD: number | null;
  /** Cash actually handed over. */
  cashD: number | null;
  /** Advance handed out, diram. */
  advanceIssuedD: number | null;

  /** The farm's outstanding advance after this row. */
  advanceBalanceD: number;
  reversed: boolean;
}

export interface FarmStatement {
  farm: { id: string; name: string; tin: string | null; place: string | null; phone: string | null };
  rows: StatementRow[];

  deliveredG: number;
  /** Payable weight of everything the lab has cleared. */
  payableG: number;
  /** Payable weight not yet paid for. */
  unpaidPayableG: number;
  /** Weight still waiting on the weighbridge or the lab, so not yet payable. */
  pendingG: number;

  advancesIssuedD: number;
  advanceRecoveredD: number;
  advanceOutstandingD: number;

  grossPaidD: number;
  cashPaidD: number;

  /** Today's valuation of the unpaid weight — an estimate, not a debt. */
  unpaidValueD: number | null;
  priceDPerKg: number | null;
}

export async function farmStatement(
  counterpartyId: string,
  priceDPerKg: number | null,
): Promise<FarmStatement | null> {
  const [farm] = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      tin: counterparties.tin,
      place: counterparties.defaultLocation,
      phone: counterparties.phone,
    })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId))
    .limit(1);
  if (!farm) return null;

  const tickets = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      status: weighTickets.status,
      netG: weighTickets.netG,
      at: raw<Date>`COALESCE(${weighTickets.weighedAt}, ${weighTickets.createdAt})`,
      plate: vehicles.plate,
      batchNumber: batches.number,
      deductionBp: raw<number | null>`COALESCE(
        (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
           FROM lab_analyses la
          WHERE la.ticket_id = weigh_tickets.id
            AND la.stage = 'on_intake' AND la.status = 'APPROVED'
            AND la.superseded_at IS NULL LIMIT 1),
        (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
           FROM lab_analyses la
          WHERE la.batch_id = weigh_tickets.batch_id
            AND la.stage = 'on_intake' AND la.status = 'APPROVED'
            AND la.superseded_at IS NULL LIMIT 1)
      )`,
    })
    .from(weighTickets)
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .where(and(eq(weighTickets.consignorId, farm.id), ne(weighTickets.status, "VOID")))
    .orderBy(desc(weighTickets.createdAt));

  const paid = await db
    .select({
      id: payments.id,
      serial: weighTickets.serial,
      ticketId: payments.ticketId,
      paidAt: payments.paidAt,
      payableG: payments.payableG,
      deductionBp: payments.deductionBp,
      priceDPerKg: payments.priceDPerKg,
      grossAmountD: payments.grossAmountD,
      advanceOffsetD: payments.advanceOffsetD,
      cashPayableD: payments.cashPayableD,
      reversedAt: payments.reversedAt,
      cashier: users.fullName,
    })
    .from(payments)
    .innerJoin(weighTickets, eq(weighTickets.id, payments.ticketId))
    .leftJoin(users, eq(users.id, payments.paidBy))
    .where(eq(payments.counterpartyId, farm.id));

  const lent = await db
    .select({
      id: advances.id,
      issuedAt: advances.issuedAt,
      principalD: advances.principalD,
      purpose: advances.purpose,
    })
    .from(advances)
    .where(eq(advances.counterpartyId, farm.id));

  // --- one timeline, oldest first, so the advance balance can be carried forward
  const events: Omit<StatementRow, "advanceBalanceD">[] = [];

  for (const t of tickets) {
    events.push({
      kind: "delivery",
      at: new Date(t.at),
      serial: t.serial,
      ticketId: t.id,
      paymentId: null,
      note: [t.plate, t.batchNumber !== null ? `№${t.batchNumber}` : null]
        .filter(Boolean)
        .join(" · ") || null,
      netG: t.netG,
      payableG:
        t.netG !== null && t.deductionBp !== null
          ? payableWeight(t.netG, Number(t.deductionBp))
          : null,
      deductionBp: t.deductionBp === null ? null : Number(t.deductionBp),
      priceDPerKg: null,
      grossAmountD: null,
      advanceOffsetD: null,
      cashD: null,
      advanceIssuedD: null,
      reversed: false,
    });
  }

  for (const a of lent) {
    events.push({
      kind: "advance",
      at: a.issuedAt,
      serial: null,
      ticketId: null,
      paymentId: null,
      note: a.purpose,
      netG: null,
      payableG: null,
      deductionBp: null,
      priceDPerKg: null,
      grossAmountD: null,
      advanceOffsetD: null,
      cashD: null,
      advanceIssuedD: a.principalD,
      reversed: false,
    });
  }

  for (const p of paid) {
    events.push({
      kind: "payment",
      at: p.paidAt,
      serial: p.serial,
      ticketId: p.ticketId,
      paymentId: p.id,
      note: p.cashier,
      netG: null,
      payableG: p.payableG,
      deductionBp: p.deductionBp,
      priceDPerKg: p.priceDPerKg,
      grossAmountD: p.grossAmountD,
      advanceOffsetD: p.advanceOffsetD,
      cashD: p.cashPayableD,
      advanceIssuedD: null,
      reversed: p.reversedAt !== null,
    });
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  let balance = 0;
  const rows: StatementRow[] = events.map((e) => {
    if (!e.reversed) {
      if (e.advanceIssuedD) balance += e.advanceIssuedD;
      if (e.advanceOffsetD) balance -= e.advanceOffsetD;
    }
    return { ...e, advanceBalanceD: balance };
  });

  // --- totals
  let deliveredG = 0;
  let payableG = 0;
  let unpaidPayableG = 0;
  let pendingG = 0;

  const paidTicketIds = new Set(paid.filter((p) => !p.reversedAt).map((p) => p.ticketId));

  for (const t of tickets) {
    const net = t.netG ?? 0;
    deliveredG += net;
    if (t.deductionBp === null) {
      pendingG += net; // not yet through the weighbridge or the lab
      continue;
    }
    const p = payableWeight(net, Number(t.deductionBp));
    payableG += p;
    if (!paidTicketIds.has(t.id)) unpaidPayableG += p;
  }

  const live = paid.filter((p) => !p.reversedAt);

  return {
    farm,
    rows: rows.reverse(), // newest first on screen; the balance was carried forward
    deliveredG,
    payableG,
    unpaidPayableG,
    pendingG,
    advancesIssuedD: lent.reduce((n, a) => n + a.principalD, 0),
    advanceRecoveredD: live.reduce((n, p) => n + p.advanceOffsetD, 0),
    advanceOutstandingD: await outstandingAdvanceD(farm.id),
    grossPaidD: live.reduce((n, p) => n + p.grossAmountD, 0),
    cashPaidD: live.reduce((n, p) => n + p.cashPayableD, 0),
    unpaidValueD:
      priceDPerKg !== null ? divRound(unpaidPayableG * priceDPerKg, 1000) : null,
    priceDPerKg,
  };
}
