import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  counterparties,
  disbursements,
  ledgerAccounts,
  ledgerEntries,
  ledgerTx,
} from "@/db/schema/index";
import { DomainError, diramToSomoniString } from "@/domain/units";
import { buildDisbursementTx } from "@/domain/ledger";
import { farmPayableAccountIdFor, primaryCashAccountId } from "./balances";

/** Anything that can run a query — the real `db`, or a transaction handle. */
type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

/**
 * Пардохти нақдӣ — handing a settled farm some of what it is owed.
 *
 * Two limits decide every disbursement, and both are read **inside** the transaction that
 * posts it: the farm's outstanding balance, and the cash in the drawer. Read a moment
 * earlier and they are not limits at all — two cashiers, or one cashier and a replayed
 * offline operation, would each see enough and both pay. docs/domain.md §4.
 */

/** The farm's payable balance, as a positive amount owed, read within `x`. */
export async function payableBalanceInTx(x: Executor, counterpartyId: string): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerAccounts.kind, "FARM_PAYABLE"),
        eq(ledgerAccounts.counterpartyId, counterpartyId),
      ),
    );
  return Math.max(0, -Number(row?.total ?? 0));
}

/** Cash across every drawer, read within `x`. */
export async function cashOnHandInTx(x: Executor): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.kind, "CASH"));
  return Number(row?.total ?? 0);
}

/**
 * The next receipt number, taken under an advisory lock held to the end of the
 * transaction. Two cashiers paying at the same second would otherwise compute the same
 * number; the unique index would then reject one of them and lose a real payment.
 */
export async function nextReceiptNo(x: Executor, season: number): Promise<string> {
  await x.execute(raw`SELECT pg_advisory_xact_lock(hashtext('zarnishon:disbursement_receipt'))`);
  const [row] = await x
    .select({ n: raw<string>`COUNT(*)` })
    .from(disbursements)
    .where(raw`EXTRACT(YEAR FROM ${disbursements.paidAt}) = ${season}`);
  return `PN-${season}-${String(Number(row?.n ?? 0) + 1).padStart(6, "0")}`;
}

/**
 * Posts the ledger transaction and the disbursement row. Used both by `payTicket`, when
 * the cashier pays at the moment of settling, and by `disburseCash`, for a later
 * instalment. Assumes `x` is already a transaction and that the caller has checked
 * nothing — every check lives here.
 */
export async function postDisbursement(
  x: Executor,
  args: {
    clientUuid: string;
    counterpartyId: string;
    counterpartyName: string;
    paymentId?: string | null;
    amountD: number;
    paidAt: Date;
    cashierId: string;
    stationId?: string | null;
    note?: string | null;
    originatedOffline?: boolean;
  },
): Promise<{ id: string; receiptNo: string; balanceAfterD: number }> {
  if (!Number.isSafeInteger(args.amountD) || args.amountD <= 0) {
    throw new DomainError("Маблағи пардохт бояд аз сифр зиёд бошад. / The amount must be positive.");
  }

  const owed = await payableBalanceInTx(x, args.counterpartyId);
  if (args.amountD > owed) {
    throw new DomainError(
      `Ин хоҷагӣ ҳамагӣ ${diramToSomoniString(owed)} сомонӣ талабгор аст. / ` +
        `This farm is owed only ${diramToSomoniString(owed)} сомонӣ.`,
    );
  }

  const cash = await cashOnHandInTx(x);
  if (args.amountD > cash) {
    throw new DomainError(
      `Дар хазина ҳамагӣ ${diramToSomoniString(cash)} сомонӣ ҳаст. / ` +
        `The drawer holds only ${diramToSomoniString(cash)} сомонӣ.`,
    );
  }

  // Resolved through `x`, not the global pool: this inserts an account carrying the
  // farm's id, and the caller is holding a lock on that farm's row.
  const cashAccountId = await primaryCashAccountId(x);
  const farmPayableAccountId = await farmPayableAccountIdFor(
    args.counterpartyId, args.counterpartyName, x,
  );

  const draft = buildDisbursementTx(
    args.amountD,
    { cashAccountId, farmPayableAccountId },
    `Пардохти нақдӣ — ${args.counterpartyName}`,
  );

  const [postedTx] = await x
    .insert(ledgerTx)
    .values({
      clientUuid: args.clientUuid,
      kind: "CASH_DISBURSEMENT",
      occurredAt: args.paidAt,
      memo: draft.memo,
      createdBy: args.cashierId,
      stationId: args.stationId ?? null,
      originatedOffline: args.originatedOffline ? 1 : 0,
    })
    .returning();
  if (!postedTx) throw new Error("Could not post the disbursement transaction.");

  await x.insert(ledgerEntries).values(
    draft.entries.map((e) => ({ txId: postedTx.id, accountId: e.accountId, amountD: e.amountD })),
  );

  const balanceAfterD = owed - args.amountD;
  const receiptNo = await nextReceiptNo(x, args.paidAt.getFullYear());

  const [row] = await x
    .insert(disbursements)
    .values({
      clientUuid: args.clientUuid,
      counterpartyId: args.counterpartyId,
      paymentId: args.paymentId ?? null,
      amountD: args.amountD,
      balanceAfterD,
      receiptNo,
      ledgerTxId: postedTx.id,
      paidAt: args.paidAt,
      paidBy: args.cashierId,
      stationId: args.stationId ?? null,
      note: args.note ?? null,
    })
    .returning({ id: disbursements.id });
  if (!row) throw new Error("Could not record the disbursement.");

  await x.insert(auditLog).values({
    action: "cash.disburse",
    entityTable: "disbursements",
    entityId: row.id,
    payload: {
      farm: args.counterpartyName,
      amountD: args.amountD,
      owedBefore: owed,
      balanceAfterD,
      receiptNo,
      paymentId: args.paymentId ?? null,
    },
    actorId: args.cashierId,
    actorRole: "cashier",
    stationId: args.stationId ?? null,
    originatedOffline: args.originatedOffline ? 1 : 0,
    occurredAt: args.paidAt,
  });

  return { id: row.id, receiptNo, balanceAfterD };
}

export interface DisburseCashInput {
  clientUuid: string;
  counterpartyId: string;
  amountD: number;
  cashierId: string;
  stationId?: string;
  note?: string;
  paidAt?: Date;
  originatedOffline?: boolean;
}

/**
 * A later instalment: the farm settled a while ago, took part of the money then, and has
 * come back for more. Paid against the farm's balance as a whole rather than against any
 * one борхат, because by now it may be owed against several.
 */
export async function disburseCash(input: DisburseCashInput): Promise<{
  disbursementId: string;
  receiptNo: string;
  amountD: number;
  balanceAfterD: number;
  replayed: boolean;
}> {
  const paidAt = input.paidAt ?? new Date();

  const [existing] = await db
    .select()
    .from(disbursements)
    .where(eq(disbursements.clientUuid, input.clientUuid))
    .limit(1);
  if (existing) {
    return {
      disbursementId: existing.id,
      receiptNo: existing.receiptNo,
      amountD: existing.amountD,
      balanceAfterD: existing.balanceAfterD,
      replayed: true,
    };
  }

  return await db.transaction(async (tx) => {
    // Lock the farm row for the duration, so two cashiers cannot both read the same
    // balance as available and each pay it out.
    const [farm] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, input.counterpartyId))
      .for("update")
      .limit(1);
    if (!farm) throw new DomainError("Хоҷагӣ ёфт нашуд. / Consignor not found.");

    const posted = await postDisbursement(tx, {
      clientUuid: input.clientUuid,
      counterpartyId: farm.id,
      counterpartyName: farm.name,
      amountD: input.amountD,
      paidAt,
      cashierId: input.cashierId,
      stationId: input.stationId ?? null,
      note: input.note ?? null,
      originatedOffline: input.originatedOffline,
    });

    return {
      disbursementId: posted.id,
      receiptNo: posted.receiptNo,
      amountD: input.amountD,
      balanceAfterD: posted.balanceAfterD,
      replayed: false,
    };
  });
}
