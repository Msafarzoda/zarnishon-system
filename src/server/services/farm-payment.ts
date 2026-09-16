import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, counterparties, disbursements } from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import {
  planFarmSettlement,
  type FarmSettlementPlan,
  type SettlementCandidate,
} from "@/domain/farm-settlement";
import { outstandingAdvanceD } from "./balances";
import { payableBalanceInTx, postDisbursement } from "./disbursements";
import { settleOneTicket, type DbTx } from "./payments";
import { resolvePriceAt } from "./pricing";
import { settlableTickets } from "./collateral";

export interface PayFarmInput {
  clientUuid: string;
  counterpartyId: string;
  /** Diram the farm asked for. Null settles everything it has in hand. */
  requestedCashD: number | null;
  cashierId: string;
  stationId?: string;
  /** Whether the stamped Copy C of every ticket settled was handed in. */
  copyCollected: boolean;
  season?: number;
  paidAt?: Date;
  originatedOffline?: boolean;
}

export interface PayFarmResult {
  farmId: string;
  farmName: string;
  /** The борхатҳо settled, oldest first. */
  settled: { paymentId: string; serial: string; grossAmountD: number; cashPayableD: number }[];
  grossAmountD: number;
  advanceOffsetD: number;
  cashPayableD: number;
  disbursedD: number;
  /** Settled beyond what was asked for — the farm may collect it later. */
  farmBalanceD: number;
  shortfallD: number;
  disbursementId: string | null;
  receiptNo: string | null;
  replayed: boolean;
}

/**
 * Пардохт ба хоҷагӣ — paying a farm an amount, rather than paying a борхат.
 *
 * The farm delivered four or five times and comes in months later asking for 6 000 сомонӣ.
 * This settles its oldest борхатҳо, whole, until they cover that — at **today's** price,
 * recovering any outstanding advance on the way — and hands over exactly what was asked
 * for. Whatever the last ticket settled beyond it stays on the farm's balance.
 *
 * Everything happens in one transaction: several settlements and one cash payment, so the
 * farm either leaves with its money and its tickets closed, or nothing happened at all.
 * docs/domain.md §4.
 */
export async function payFarm(input: PayFarmInput): Promise<PayFarmResult> {
  const paidAt = input.paidAt ?? new Date();
  const season = input.season ?? paidAt.getFullYear();

  if (
    input.requestedCashD !== null &&
    (!Number.isSafeInteger(input.requestedCashD) || input.requestedCashD < 0)
  ) {
    throw new DomainError("Маблағи дархостшуда нодуруст аст. / The requested amount is not valid.");
  }

  /*
   * Replayed by the offline queue after a timeout: the cash already went out, and the
   * only safe answer is the original one. Keyed on the disbursement, which is written
   * last — if it is there, every settlement before it committed in the same transaction.
   */
  const payoutUuid = derivedUuid(input.clientUuid, "payout");
  const [alreadyPaid] = await db
    .select()
    .from(disbursements)
    .where(eq(disbursements.clientUuid, payoutUuid))
    .limit(1);
  if (alreadyPaid) {
    const [farm] = await db
      .select({ name: counterparties.name })
      .from(counterparties)
      .where(eq(counterparties.id, input.counterpartyId))
      .limit(1);
    return {
      farmId: input.counterpartyId,
      farmName: farm?.name ?? "",
      settled: [],
      grossAmountD: 0,
      advanceOffsetD: 0,
      cashPayableD: 0,
      disbursedD: alreadyPaid.amountD,
      farmBalanceD: alreadyPaid.balanceAfterD,
      shortfallD: 0,
      disbursementId: alreadyPaid.id,
      receiptNo: alreadyPaid.receiptNo,
      replayed: true,
    };
  }

  return await db.transaction(async (tx) => {
    // Lock the farm: two cashiers must not plan against the same tickets at once.
    const [farm] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, input.counterpartyId))
      .for("update")
      .limit(1);
    if (!farm) throw new DomainError("Хоҷагӣ ёфт нашуд. / Consignor not found.");

    const plan = await planFor(tx, {
      counterpartyId: farm.id,
      season,
      requestedCashD: input.requestedCashD,
      at: paidAt,
    });

    if (plan.tickets.length === 0 && plan.disburseD === 0) {
      throw new DomainError(
        "Ин хоҷагӣ борхати омодаи пардохт надорад. / This farm has nothing ready to settle.",
      );
    }

    const settled: PayFarmResult["settled"] = [];
    let grossAmountD = 0;
    let advanceOffsetD = 0;
    let cashPayableD = 0;

    for (const t of plan.tickets) {
      // One key per ticket, derived from the operation's own key, so a replayed request
      // finds every settlement already there instead of making a second set.
      const one = await settleOneTicket(tx, {
        clientUuid: derivedUuid(input.clientUuid, `ticket:${t.ticketId}`),
        ticketId: t.ticketId,
        cashierId: input.cashierId,
        stationId: input.stationId ?? null,
        copyCollected: input.copyCollected,
        paidAt,
        originatedOffline: input.originatedOffline,
      });
      settled.push({
        paymentId: one.paymentId,
        serial: one.serial,
        grossAmountD: one.grossAmountD,
        cashPayableD: one.cashPayableD,
      });
      grossAmountD += one.grossAmountD;
      advanceOffsetD += one.advanceOffsetD;
      cashPayableD += one.cashPayableD;
    }

    /*
     * What actually leaves the drawer. Read back from the ledger rather than taken from
     * the plan: the plan was made from a snapshot, and a price or a lab result that moved
     * between planning and posting must not let more cash out than the farm is owed. By
     * this point the balance holds both what it was owed before and what the settlements
     * above just added.
     */
    const availableD = (await payableBalanceInTx(tx, farm.id));
    const wanted = input.requestedCashD ?? availableD;
    const disburseD = Math.min(wanted, availableD);

    let disbursement: { id: string; receiptNo: string; balanceAfterD: number } | null = null;
    if (disburseD > 0) {
      disbursement = await postDisbursement(tx, {
        clientUuid: payoutUuid,
        counterpartyId: farm.id,
        counterpartyName: farm.name,
        // Against the farm's balance, not against any one борхат: this money came out of
        // several, and pinning it to the first would misdescribe the other receipts.
        paymentId: null,
        amountD: disburseD,
        paidAt,
        cashierId: input.cashierId,
        stationId: input.stationId ?? null,
        note: `${settled.length} × борхат`,
        originatedOffline: input.originatedOffline,
      });
    }

    const farmBalanceD = await payableBalanceInTx(tx, farm.id);

    await tx.insert(auditLog).values({
      action: "farm.pay",
      entityTable: "counterparties",
      entityId: farm.id,
      payload: {
        farm: farm.name,
        requestedCashD: input.requestedCashD,
        serials: settled.map((s) => s.serial),
        grossAmountD,
        advanceOffsetD,
        cashPayableD,
        disbursedD: disburseD,
        farmBalanceD,
      },
      actorId: input.cashierId,
      actorRole: "cashier",
      stationId: input.stationId ?? null,
      originatedOffline: input.originatedOffline ? 1 : 0,
      occurredAt: paidAt,
    });

    return {
      farmId: farm.id,
      farmName: farm.name,
      settled,
      grossAmountD,
      advanceOffsetD,
      cashPayableD,
      disbursedD: disburseD,
      farmBalanceD,
      shortfallD: Math.max(0, wanted - availableD),
      disbursementId: disbursement?.id ?? null,
      receiptNo: disbursement?.receiptNo ?? null,
      replayed: false,
    };
  });
}

/**
 * What settling this farm for an amount would come to, without posting anything.
 *
 * The cash desk shows this before the cashier commits, and it is the same call the posting
 * path makes — so the tickets listed on screen are the tickets that will be settled.
 */
export async function previewFarmPayment(args: {
  counterpartyId: string;
  requestedCashD: number | null;
  season?: number;
  at?: Date;
}): Promise<FarmSettlementPlan & { unpriced: string[] }> {
  const at = args.at ?? new Date();
  return await planFor(db, {
    counterpartyId: args.counterpartyId,
    season: args.season ?? at.getFullYear(),
    requestedCashD: args.requestedCashD,
    at,
  });
}

/**
 * Build the plan: find what is settlable, price each ticket by its own variety, then let
 * the pure planner decide which of them the amount asked for reaches.
 *
 * Prices are resolved per variety, the same way each settlement will resolve them — a
 * headline price on screen and a variety price in the ledger is how a farmer ends up with
 * a different number from the one he was shown. A variety with no price in force cannot be
 * settled at all, and its борхат is named in `unpriced` rather than silently dropped.
 */
async function planFor(
  x: DbTx | typeof db,
  args: { counterpartyId: string; season: number; requestedCashD: number | null; at: Date },
): Promise<FarmSettlementPlan & { unpriced: string[] }> {
  const rows = await settlableTickets(args.counterpartyId, args.season, x);

  const priceByVariety = new Map<string | null, number | null>();
  for (const varietyId of new Set(rows.map((r) => r.varietyId))) {
    try {
      priceByVariety.set(varietyId, (await resolvePriceAt(args.at, varietyId, x)).priceDPerKg);
    } catch {
      priceByVariety.set(varietyId, null);
    }
  }

  const candidates: SettlementCandidate[] = [];
  const unpriced: string[] = [];
  for (const r of rows) {
    const priceDPerKg = priceByVariety.get(r.varietyId) ?? null;
    if (priceDPerKg === null) {
      unpriced.push(r.serial);
      continue;
    }
    candidates.push({
      ticketId: r.ticketId,
      serial: r.serial,
      weighedAt: (r.weighedAt ?? new Date(0)).getTime(),
      netG: r.netG,
      deductionBp: r.deductionBp,
      priceDPerKg,
    });
  }

  const plan = planFarmSettlement({
    candidates,
    requestedCashD: args.requestedCashD,
    outstandingAdvanceD: await outstandingAdvanceD(args.counterpartyId, x),
    // Spent before any cotton is sold, so a farm collecting money it is already owed does
    // not have a борхат settled at today's price for nothing.
    existingBalanceD: await payableBalanceInTx(x, args.counterpartyId),
  });

  return { ...plan, unpriced };
}

/**
 * A derived, still-unique UUID for one of the several writes an operation makes.
 *
 * Settling a farm posts a payment per борхат and one disbursement under a single request,
 * and each row needs its own idempotency key. They are **derived** from the request's key
 * rather than generated, so a replay after a timeout finds every row already written — a
 * fresh key per attempt would settle the same tickets a second time.
 *
 * Hashed rather than built by editing hex digits in place: a farm can have any number of
 * борхатҳо waiting, and an index poked into one nibble quietly caps it at fifteen.
 */
function derivedUuid(base: string, label: string): string {
  const h = createHash("sha256").update(`${base}:${label}`).digest("hex");
  // Stamped as a v8 UUID — "custom", which is exactly what this is.
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-` +
    `${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
  );
}
