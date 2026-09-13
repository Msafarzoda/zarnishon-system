import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { ledgerAccounts, ledgerEntries } from "@/db/schema/index";

/**
 * Every balance in this system is a SUM over the ledger. There is no stored balance
 * column anywhere, so there is nothing for anyone to type over. docs/domain.md §5.
 */
export async function accountBalanceD(accountId: string): Promise<number> {
  const [row] = await db
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  return Number(row?.total ?? 0);
}

/** Нақди дар хазина — cash on hand across every cash drawer. */
export async function cashOnHandD(): Promise<number> {
  const [row] = await db
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
export async function outstandingAdvanceD(counterpartyId: string): Promise<number> {
  const [row] = await db
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

/** Finds, or lazily creates, the advance account for one farm. */
export async function advanceAccountIdFor(
  counterpartyId: string,
  counterpartyName: string,
): Promise<string> {
  const [existing] = await db
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

  const [created] = await db
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
export async function primaryCashAccountId(): Promise<string> {
  const [row] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, "CASH"))
    .limit(1);
  if (!row) throw new Error("Ҳисоби хазина мавҷуд нест. / No cash account exists.");
  return row.id;
}

export async function accountIdByKind(kind: "COTTON_PURCHASE" | "SEED_REVENUE" | "OPENING_BALANCE") {
  const [row] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, kind))
    .limit(1);
  if (!row) throw new Error(`No ledger account of kind ${kind} exists.`);
  return row.id;
}
