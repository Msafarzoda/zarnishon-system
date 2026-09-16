import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  counterparties,
  disbursements,
  ledgerEntries,
  ledgerTx,
  payments,
  weighTickets,
} from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { settleTicket } from "@/domain/settlement";
import { buildCottonPaymentTx, buildDisbursementTx } from "@/domain/ledger";
import { transition } from "@/domain/ticket";
import type { TicketStatus } from "@/domain/ticket";
import {
  accountIdByKind,
  advanceAccountIdFor,
  farmPayableAccountIdFor,
  outstandingAdvanceD,
} from "./balances";
import { payableBalanceInTx, postDisbursement } from "./disbursements";
import { resolvePriceAt } from "./pricing";
/**
 * A transaction handle. Typed off `db.transaction`'s own callback so it cannot drift from
 * whatever Drizzle actually hands over.
 */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
import { analysisForTicket } from "./lab";

export interface PayTicketInput {
  /** Idempotency key from the cash desk. Replaying it returns the original payment. */
  clientUuid: string;
  ticketId: string;
  cashierId: string;
  stationId?: string;
  /** Whether the stamped Copy C was physically handed in and collected. */
  copyCollected: boolean;
  /**
   * Cash to hand over right now, diram. Defaults to the whole `cash_payable_d`.
   *
   * Pass less when the farm asks for less, or when the drawer does not hold enough —
   * the remainder stays on the farm's payable balance and is collected later. Pass 0 for
   * "we will pay you later", which settles the ticket and moves no cash at all.
   */
  disburseD?: number;
  /** Defaults to now. The price of THIS date is the one applied. */
  paidAt?: Date;
  originatedOffline?: boolean;
}

export interface PayTicketResult {
  paymentId: string;
  invoiceNo: string;
  payableG: number;
  priceDPerKg: number;
  grossAmountD: number;
  advanceOffsetD: number;
  cashPayableD: number;
  remainingAdvanceD: number;
  /** Cash actually handed over as part of this settlement. May be 0, or less than the payable. */
  disbursedD: number;
  /** What the farm may still come and collect after this settlement. */
  farmBalanceD: number;
  /** Receipt for the cash handed over now, when any was. */
  disbursementId: string | null;
  /** True when this call replayed an already-applied payment rather than making a new one. */
  replayed: boolean;
}

/**
 * Пардохт — pay one ticket against the farmer's stamped Copy C.
 *
 * Everything happens in one transaction, and the `payments.ticket_id` unique index is the
 * real guarantee: even two cash desks racing, or an offline queue replaying, cannot pay
 * the same ticket twice. docs/domain.md §4.
 */
export async function payTicket(input: PayTicketInput): Promise<PayTicketResult> {
  const paidAt = input.paidAt ?? new Date();

  // Idempotent replay: the cash desk retried a queued operation.
  const [existing] = await db
    .select()
    .from(payments)
    .where(eq(payments.clientUuid, input.clientUuid))
    .limit(1);
  if (existing) {
    const [handed] = await db
      .select({ id: disbursements.id, amountD: disbursements.amountD,
                balanceAfterD: disbursements.balanceAfterD })
      .from(disbursements)
      .where(eq(disbursements.paymentId, existing.id))
      .limit(1);
    return {
      paymentId: existing.id,
      invoiceNo: existing.invoiceNo,
      payableG: existing.payableG,
      priceDPerKg: existing.priceDPerKg,
      grossAmountD: existing.grossAmountD,
      advanceOffsetD: existing.advanceOffsetD,
      cashPayableD: existing.cashPayableD,
      remainingAdvanceD: 0,
      disbursedD: handed?.amountD ?? 0,
      farmBalanceD: handed?.balanceAfterD ?? existing.cashPayableD,
      disbursementId: handed?.id ?? null,
      replayed: true,
    };
  }

  return await db.transaction(async (tx) => {
    const settlement = await settleOneTicket(tx, {
      clientUuid: input.clientUuid,
      ticketId: input.ticketId,
      cashierId: input.cashierId,
      stationId: input.stationId ?? null,
      copyCollected: input.copyCollected,
      paidAt,
      originatedOffline: input.originatedOffline,
    });

    /**
     * How much actually leaves the drawer now. Unspecified means the whole payable, which
     * is the ordinary case; the cashier passes less when the farm asks for less or the
     * drawer is short, and 0 for "we will pay you later". Anything above the payable is a
     * mistake, not a generosity, so it is refused rather than clamped.
     */
    const requested = input.disburseD ?? settlement.cashPayableD;
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new DomainError("Маблағи пардохт нодуруст аст. / The amount to hand over is not valid.");
    }
    if (requested > settlement.cashPayableD) {
      throw new DomainError(
        "Маблағи пардохт аз маблағи борхат зиёд аст. / More than this ticket is worth.",
      );
    }

    let disbursement: { id: string; receiptNo: string; balanceAfterD: number } | null = null;
    if (requested > 0) {
      disbursement = await postDisbursement(tx, {
        // Derived from the settlement's own key, so a replayed settlement replays its
        // disbursement too instead of paying a second time.
        clientUuid: disbursementUuidFor(input.clientUuid),
        counterpartyId: settlement.farmId,
        counterpartyName: settlement.farmName,
        paymentId: settlement.paymentId,
        amountD: requested,
        paidAt,
        cashierId: input.cashierId,
        stationId: input.stationId ?? null,
        originatedOffline: input.originatedOffline,
      });
    }

    const farmBalanceD = await payableBalanceInTx(tx, settlement.farmId);

    return {
      paymentId: settlement.paymentId,
      invoiceNo: settlement.invoiceNo,
      payableG: settlement.payableG,
      priceDPerKg: settlement.priceDPerKg,
      grossAmountD: settlement.grossAmountD,
      advanceOffsetD: settlement.advanceOffsetD,
      cashPayableD: settlement.cashPayableD,
      remainingAdvanceD: settlement.remainingAdvanceD,
      disbursedD: requested,
      farmBalanceD,
      disbursementId: disbursement?.id ?? null,
      replayed: false,
    };
  });
}

export interface SettleOneResult {
  paymentId: string;
  invoiceNo: string;
  farmId: string;
  farmName: string;
  serial: string;
  payableG: number;
  priceDPerKg: number;
  grossAmountD: number;
  advanceOffsetD: number;
  cashPayableD: number;
  remainingAdvanceD: number;
}

/**
 * Settle exactly one борхат inside a transaction that is already open.
 *
 * Split out of `payTicket` so that settling a farm's several tickets in one go — which is
 * what a farm asking for an amount rather than for a борхат needs — posts them the same
 * way, in one transaction, with the advance recovered across the run. No cash moves here;
 * the caller decides what, if anything, is handed over. docs/domain.md §4.
 */
export async function settleOneTicket(
  tx: DbTx,
  input: {
    clientUuid: string;
    ticketId: string;
    cashierId: string;
    stationId?: string | null;
    copyCollected: boolean;
    paidAt: Date;
    originatedOffline?: boolean;
  },
): Promise<SettleOneResult> {
  const { paidAt } = input;
  {
    // Lock the ticket for the duration so two cashiers cannot both read it as unpaid.
    const [ticket] = await tx
      .select()
      .from(weighTickets)
      .where(eq(weighTickets.id, input.ticketId))
      .for("update")
      .limit(1);
    if (!ticket) {
      throw new DomainError("Борхат ёфт нашуд. / Ticket not found.");
    }

    // Throws with an operator-readable Tajik message for the already-paid /
    // not-yet-analysed / voided cases.
    const nextStatus = transition(ticket.status as TicketStatus, "PAY");

    if (ticket.netG === null) {
      throw new DomainError("Вазни нетто муайян нашудааст. / Net weight is not established.");
    }

    // Every truck is sampled, so this is normally the truck's own result; a партия
    // certificate covers one that was not sampled individually.
    const analysis = await analysisForTicket(tx, ticket.id, ticket.batchId);
    if (!analysis) {
      throw new DomainError(
        "Таҳлили лаборатория тасдиқ нашудааст. / This load has not been through the lab.",
      );
    }
    const deductionBp = analysis.overrideDeductionBp ?? analysis.computedDeductionBp;

    const [farm] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, ticket.consignorId))
      .limit(1);
    if (!farm) throw new DomainError("Хоҷагӣ ёфт нашуд. / Consignor not found.");

    const price = await resolvePriceAt(paidAt, ticket.varietyId, tx);
    const advanceD = await outstandingAdvanceD(farm.id, tx);

    const settlement = settleTicket({
      netG: ticket.netG,
      deductionBp,
      priceDPerKg: price.priceDPerKg,
      outstandingAdvanceD: advanceD,
    });

    const cottonPurchaseAccountId = await accountIdByKind("COTTON_PURCHASE", tx);
    const farmPayableAccountId = await farmPayableAccountIdFor(farm.id, farm.name, tx);
    const advanceAccountId =
      settlement.advanceOffsetD > 0 ? await advanceAccountIdFor(farm.id, farm.name, tx) : undefined;

    // Settling moves no cash: it records what the factory now owes. The cash, if any
    // changes hands today, is a second transaction below.
    const draft = buildCottonPaymentTx(
      settlement,
      { cottonPurchaseAccountId, farmPayableAccountId, advanceAccountId },
      `Ҳисоббаробаркунӣ аз рӯи борхат ${ticket.serial} — ${farm.name}`,
    );

    const [postedTx] = await tx
      .insert(ledgerTx)
      .values({
        clientUuid: input.clientUuid,
        kind: "COTTON_PAYMENT",
        occurredAt: paidAt,
        memo: draft.memo,
        createdBy: input.cashierId,
        stationId: input.stationId ?? null,
        originatedOffline: input.originatedOffline ? 1 : 0,
      })
      .returning();
    if (!postedTx) throw new Error("Could not post the payment transaction.");

    await tx.insert(ledgerEntries).values(
      draft.entries.map((e) => ({
        txId: postedTx.id,
        accountId: e.accountId,
        amountD: e.amountD,
      })),
    );

    // One payment per ticket, so the serial makes a unique invoice number with no sequence.
    const invoiceNo = `INV-${ticket.serial}`;

    const [payment] = await tx
      .insert(payments)
      .values({
        clientUuid: input.clientUuid,
        ticketId: ticket.id,
        counterpartyId: farm.id,
        netG: ticket.netG,
        deductionBp,
        payableG: settlement.payableG,
        priceDPerKg: settlement.priceDPerKg,
        priceQuoteId: price.priceQuoteId,
        labAnalysisId: analysis.id,
        grossAmountD: settlement.grossAmountD,
        advanceOffsetD: settlement.advanceOffsetD,
        cashPayableD: settlement.cashPayableD,
        invoiceNo,
        ledgerTxId: postedTx.id,
        paidAt,
        paidBy: input.cashierId,
        stationId: input.stationId ?? null,
        copyCollected: input.copyCollected,
      })
      .returning();
    if (!payment) throw new Error("Could not record the payment.");

    await tx
      .update(weighTickets)
      .set({ status: nextStatus, paidAt })
      .where(eq(weighTickets.id, ticket.id));

    await tx.insert(auditLog).values({
      action: "ticket.settle",
      entityTable: "payments",
      entityId: payment.id,
      payload: {
        ticketSerial: ticket.serial,
        farm: farm.name,
        netG: ticket.netG,
        deductionBp,
        payableG: settlement.payableG,
        priceDPerKg: settlement.priceDPerKg,
        grossAmountD: settlement.grossAmountD,
        advanceOffsetD: settlement.advanceOffsetD,
        cashPayableD: settlement.cashPayableD,
        copyCollected: input.copyCollected,
      },
      actorId: input.cashierId,
      actorRole: "cashier",
      stationId: input.stationId ?? null,
      originatedOffline: input.originatedOffline ? 1 : 0,
      occurredAt: paidAt,
    });

    return {
      paymentId: payment.id,
      invoiceNo,
      farmId: farm.id,
      farmName: farm.name,
      serial: ticket.serial,
      payableG: settlement.payableG,
      priceDPerKg: settlement.priceDPerKg,
      grossAmountD: settlement.grossAmountD,
      advanceOffsetD: settlement.advanceOffsetD,
      cashPayableD: settlement.cashPayableD,
      remainingAdvanceD: settlement.remainingAdvanceD,
    };
  }
}

/**
 * The idempotency key for the cash handed over as part of a settlement.
 *
 * Derived from the settlement's own key rather than generated, so that a queued operation
 * replayed after a timeout finds both rows already there. A fresh key each time would
 * settle once and pay twice.
 */
function disbursementUuidFor(paymentClientUuid: string): string {
  // Flip the UUID's version nibble to 8: still a valid, still-unique v8 UUID, and a pure
  // function of the payment's key.
  return `${paymentClientUuid.slice(0, 14)}8${paymentClientUuid.slice(15)}`;
}
