import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  counterparties,
  labAnalyses,
  ledgerEntries,
  ledgerTx,
  payments,
  weighTickets,
} from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { settleTicket } from "@/domain/settlement";
import { buildCottonPaymentTx } from "@/domain/ledger";
import { transition } from "@/domain/ticket";
import type { TicketStatus } from "@/domain/ticket";
import {
  accountIdByKind,
  advanceAccountIdFor,
  outstandingAdvanceD,
  primaryCashAccountId,
} from "./balances.js";
import { resolvePriceAt } from "./pricing.js";

export interface PayTicketInput {
  /** Idempotency key from the cash desk. Replaying it returns the original payment. */
  clientUuid: string;
  ticketId: string;
  cashierId: string;
  stationId?: string;
  /** Whether the stamped Copy C was physically handed in and collected. */
  copyCollected: boolean;
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
    return {
      paymentId: existing.id,
      invoiceNo: existing.invoiceNo,
      payableG: existing.payableG,
      priceDPerKg: existing.priceDPerKg,
      grossAmountD: existing.grossAmountD,
      advanceOffsetD: existing.advanceOffsetD,
      cashPayableD: existing.cashPayableD,
      remainingAdvanceD: 0,
      replayed: true,
    };
  }

  return await db.transaction(async (tx) => {
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
    if (!ticket.batchId) {
      throw new DomainError("Борхат ба партия вобаста карда нашудааст. / Ticket has no batch.");
    }

    // The approved intake analysis for this ticket's партия.
    const [analysis] = await tx
      .select()
      .from(labAnalyses)
      .where(
        and(
          eq(labAnalyses.batchId, ticket.batchId),
          eq(labAnalyses.stage, "on_intake"),
          eq(labAnalyses.status, "APPROVED"),
        ),
      )
      .limit(1);
    if (!analysis) {
      throw new DomainError(
        "Таҳлили лаборатория тасдиқ нашудааст. / No approved lab analysis for this batch.",
      );
    }
    const deductionBp = analysis.overrideDeductionBp ?? analysis.computedDeductionBp;

    const [farm] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, ticket.consignorId))
      .limit(1);
    if (!farm) throw new DomainError("Хоҷагӣ ёфт нашуд. / Consignor not found.");

    const price = await resolvePriceAt(paidAt, ticket.varietyId);
    const advanceD = await outstandingAdvanceD(farm.id);

    const settlement = settleTicket({
      netG: ticket.netG,
      deductionBp,
      priceDPerKg: price.priceDPerKg,
      outstandingAdvanceD: advanceD,
    });

    const cashAccountId = await primaryCashAccountId();
    const cottonPurchaseAccountId = await accountIdByKind("COTTON_PURCHASE");
    const advanceAccountId =
      settlement.advanceOffsetD > 0 ? await advanceAccountIdFor(farm.id, farm.name) : undefined;

    const draft = buildCottonPaymentTx(
      settlement,
      { cashAccountId, cottonPurchaseAccountId, advanceAccountId },
      `Пардохт аз рӯи борхат ${ticket.serial} — ${farm.name}`,
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
      action: "ticket.pay",
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
      payableG: settlement.payableG,
      priceDPerKg: settlement.priceDPerKg,
      grossAmountD: settlement.grossAmountD,
      advanceOffsetD: settlement.advanceOffsetD,
      cashPayableD: settlement.cashPayableD,
      remainingAdvanceD: settlement.remainingAdvanceD,
      replayed: false,
    };
  });
}
