import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { ledgerAccounts, ledgerEntries } from "@/db/schema/index";

/**
 * Anything that can run a query — the real `db`, or a transaction handle.
 *
 * Every function here takes one, and callers inside a transaction **must** pass it. These
 * helpers insert ledger accounts, and an insert carrying a `counterparty_id` takes a
 * foreign-key lock on that farm's row. Run from the global pool while a transaction holds
 * `FOR UPDATE` on the same row, that insert waits for the transaction and the transaction
 * waits for the insert — a deadlock across two connections that Postgres cannot break,
 * because one of the two waiters is the application rather than the database.
 */
type Executor = Pick<typeof db, "select" | "insert">;

/**
 * Every balance in this system is a SUM over the ledger. There is no stored balance
 * column anywhere, so there is nothing for anyone to type over. docs/domain.md §5.
 */
export async function accountBalanceD(accountId: string, x: Executor = db): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  return Number(row?.total ?? 0);
}

/** Нақди дар хазина — cash on hand across every cash drawer. */
export async function cashOnHandD(x: Executor = db): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.kind, "CASH"));
  return Number(row?.total ?? 0);
}

/**
 * Қарзи боқимонда — what a farm still owes us.
 * ADVANCE_RECEIVABLE is debit-normal, so a positive balance means the farm owes us.
 */
export async function outstandingAdvanceD(
  counterpartyId: string,
  x: Executor = db,
): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerAccounts.kind, "ADVANCE_RECEIVABLE"),
        eq(ledgerAccounts.counterpartyId, counterpartyId),
      ),
    );
  return Math.max(0, Number(row?.total ?? 0));
}

/**
 * Қарзи мо ба хоҷагӣ — settled cotton money this farm has not collected yet.
 *
 * FARM_PAYABLE is credit-normal, so the raw sum is negative when we owe. It is returned
 * as a positive amount owed, because that is how anyone at the desk says it.
 */
export async function farmPayableD(
  counterpartyId: string,
  x: Executor = db,
): Promise<number> {
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

/** Everything the factory owes every farm together — the cash desk's own liability. */
export async function totalFarmPayableD(x: Executor = db): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.kind, "FARM_PAYABLE"));
  return Math.max(0, -Number(row?.total ?? 0));
}

/** Finds, or lazily creates, the payable account for one farm. */
export async function farmPayableAccountIdFor(
  counterpartyId: string,
  counterpartyName: string,
  x: Executor = db,
): Promise<string> {
  const [existing] = await x
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, "FARM_PAYABLE"),
        eq(ledgerAccounts.counterpartyId, counterpartyId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await x
    .insert(ledgerAccounts)
    .values({
      code: `PAY-${counterpartyId.slice(0, 8)}`,
      nameTg: `Қарзи мо ба ${counterpartyName}`,
      kind: "FARM_PAYABLE",
      counterpartyId,
    })
    .returning({ id: ledgerAccounts.id });
  if (!created) throw new Error("Could not create the payable account for this farm.");
  return created.id;
}

/** Finds, or lazily creates, the advance account for one farm. */
export async function advanceAccountIdFor(
  counterpartyId: string,
  counterpartyName: string,
  x: Executor = db,
): Promise<string> {
  const [existing] = await x
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, "ADVANCE_RECEIVABLE"),
        eq(ledgerAccounts.counterpartyId, counterpartyId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await x
    .insert(ledgerAccounts)
    .values({
      code: `ADV-${counterpartyId.slice(0, 8)}`,
      nameTg: `Қарзи ${counterpartyName}`,
      kind: "ADVANCE_RECEIVABLE",
      counterpartyId,
    })
    .returning({ id: ledgerAccounts.id });
  if (!created) throw new Error("Could not create the advance account for this farm.");
  return created.id;
}

/** The single cash drawer. Multi-drawer support is a matter of passing an id instead. */
export async function primaryCashAccountId(x: Executor = db): Promise<string> {
  const [row] = await x
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, "CASH"))
    .limit(1);
  if (!row) throw new Error("Ҳисоби хазина мавҷуд нест. / No cash account exists.");
  return row.id;
}

export async function accountIdByKind(
  kind: "COTTON_PURCHASE" | "SEED_REVENUE" | "PRODUCT_REVENUE" | "OPENING_BALANCE" | "OPERATING_EXPENSE",
  x: Executor = db,
) {
  const [row] = await x
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, kind))
    .limit(1);
  if (!row) throw new Error(`No ledger account of kind ${kind} exists.`);
  return row.id;
}

// ---------------------------------------------------------------- phase 2, §7

/**
 * Даромад аз фурӯши маҳсулот — the one income account for чигит, улюк, пучоқ and кип.
 *
 * Created on first use rather than by the seed. This account arrived a season after the
 * books did, and a factory server that has been running since intake opened will never
 * run the seed again — so a lazily-created account is the difference between the first
 * sale working and the first sale being a foreign-key error at the loading bay.
 */
export async function productRevenueAccountId(x: Executor = db): Promise<string> {
  const [existing] = await x
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, "PRODUCT_REVENUE"))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await x
    .insert(ledgerAccounts)
    .values({
      code: "REV-PROD",
      nameTg: "Даромад аз фурӯши маҳсулот",
      kind: "PRODUCT_REVENUE",
    })
    .returning({ id: ledgerAccounts.id });
  if (!created) throw new Error("Could not create the product revenue account.");
  return created.id;
}

/** Finds, or lazily creates, the receivable account for one buyer. */
export async function buyerReceivableAccountIdFor(
  counterpartyId: string,
  counterpartyName: string,
  x: Executor = db,
): Promise<string> {
  const [existing] = await x
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, "BUYER_RECEIVABLE"),
        eq(ledgerAccounts.counterpartyId, counterpartyId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await x
    .insert(ledgerAccounts)
    .values({
      code: `BUY-${counterpartyId.slice(0, 8)}`,
      nameTg: `Қарзи ${counterpartyName} ба мо`,
      kind: "BUYER_RECEIVABLE",
      counterpartyId,
    })
    .returning({ id: ledgerAccounts.id });
  if (!created) throw new Error("Could not create the receivable account for this buyer.");
  return created.id;
}

/**
 * Қарзи харидор — what one buyer has taken and not paid for.
 * BUYER_RECEIVABLE is debit-normal, so a positive balance means the buyer owes us.
 */
export async function buyerReceivableD(
  counterpartyId: string,
  x: Executor = db,
): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerAccounts.kind, "BUYER_RECEIVABLE"),
        eq(ledgerAccounts.counterpartyId, counterpartyId),
      ),
    );
  return Math.max(0, Number(row?.total ?? 0));
}

/** Everything every buyer owes us together. */
export async function totalBuyerReceivableD(x: Executor = db): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.kind, "BUYER_RECEIVABLE"));
  return Math.max(0, Number(row?.total ?? 0));
}
