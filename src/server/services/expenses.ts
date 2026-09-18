import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  expenseCategories,
  expenses,
  ledgerAccounts,
  ledgerEntries,
  ledgerTx,
  users,
} from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { buildOperatingExpenseTx } from "@/domain/ledger";
import { primaryCashAccountId } from "./balances";
import { cashOnHandInTx } from "./disbursements";

/** Anything that can run a query — the real `db`, or a transaction handle. */
type Executor = Pick<typeof db, "select" | "insert">;

/**
 * Every category the owner has named, active first, alphabetical within that — the same
 * ordering an operator scanning a short dropdown actually wants.
 */
export async function listExpenseCategories() {
  return await db
    .select()
    .from(expenseCategories)
    .where(eq(expenseCategories.isActive, true))
    .orderBy(asc(expenseCategories.nameTg));
}

/**
 * Names a new category — маош, ошхона, таъмир, or whatever the owner calls it next. Not
 * an enum: a category is a row, so adding one is not a code change and a redeploy.
 */
export async function createExpenseCategory(input: { nameTg: string; createdBy: string }) {
  const nameTg = input.nameTg.trim();
  if (!nameTg) throw new DomainError("Номи категория ҳатмист. / A category name is required.");

  const [existing] = await db
    .select()
    .from(expenseCategories)
    .where(eq(expenseCategories.nameTg, nameTg));
  if (existing) return existing;

  const [row] = await db
    .insert(expenseCategories)
    .values({ nameTg, createdBy: input.createdBy })
    .returning();
  if (!row) throw new Error("Could not create the category.");
  return row;
}

/**
 * The one ledger account every expense posts against, whatever its category — created on
 * first use, since this account arrived a season after the books were opened. See
 * `productRevenueAccountId` in balances.ts for the same reasoning.
 */
async function operatingExpenseAccountId(x: Executor): Promise<string> {
  const [existing] = await x
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, "OPERATING_EXPENSE"))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await x
    .insert(ledgerAccounts)
    .values({ code: "OPEX-1", nameTg: "Харочоти корхона", kind: "OPERATING_EXPENSE" })
    .returning({ id: ledgerAccounts.id });
  if (!created) throw new Error("Could not create the operating-expense account.");
  return created.id;
}

export interface RecordExpenseInput {
  clientUuid: string;
  categoryId: string;
  amountD: number;
  note?: string;
  recordedBy: string;
  stationId?: string;
  occurredAt?: Date;
}

/**
 * Харочот — cash out for something that is not cotton: payroll, kitchen supplies, a
 * repair. One ledger shape for all of it (Dr OPERATING_EXPENSE / Cr CASH); the category
 * is what makes "how much did payroll cost this season" answerable without pulling the
 * memo text apart. docs/domain.md §4 covers the same drawer-limit reasoning as advances
 * and disbursements: the cash on hand is read inside the transaction that spends it.
 */
export async function recordExpense(input: RecordExpenseInput) {
  const [replay] = await db
    .select()
    .from(expenses)
    .where(eq(expenses.clientUuid, input.clientUuid))
    .limit(1);
  if (replay) return { expenseId: replay.id, replayed: true as const };

  if (!Number.isSafeInteger(input.amountD) || input.amountD <= 0) {
    throw new DomainError("Маблағ бояд аз сифр зиёд бошад. / The amount must be positive.");
  }

  const occurredAt = input.occurredAt ?? new Date();

  return await db.transaction(async (tx) => {
    const [category] = await tx
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, input.categoryId))
      .limit(1);
    if (!category) throw new DomainError("Категория ёфт нашуд. / Category not found.");

    const cash = await cashOnHandInTx(tx);
    if (input.amountD > cash) {
      throw new DomainError(
        `Дар хазина ҳамагӣ ${(cash / 100).toFixed(2)} сомонӣ ҳаст. / ` +
          `The drawer holds only ${(cash / 100).toFixed(2)} сомонӣ.`,
      );
    }

    const cashAccountId = await primaryCashAccountId(tx);
    const expenseAccountId = await operatingExpenseAccountId(tx);

    const draft = buildOperatingExpenseTx(
      input.amountD,
      { cashAccountId, expenseAccountId },
      `${category.nameTg}${input.note ? ` — ${input.note}` : ""}`,
    );

    const [postedTx] = await tx
      .insert(ledgerTx)
      .values({
        clientUuid: input.clientUuid,
        kind: "OPERATING_EXPENSE",
        occurredAt,
        memo: draft.memo,
        createdBy: input.recordedBy,
        stationId: input.stationId ?? null,
      })
      .returning();
    if (!postedTx) throw new Error("Could not post the expense.");

    await tx.insert(ledgerEntries).values(
      draft.entries.map((e) => ({ txId: postedTx.id, accountId: e.accountId, amountD: e.amountD })),
    );

    const [row] = await tx
      .insert(expenses)
      .values({
        clientUuid: input.clientUuid,
        categoryId: category.id,
        amountD: input.amountD,
        note: input.note?.trim() || null,
        ledgerTxId: postedTx.id,
        occurredAt,
        recordedBy: input.recordedBy,
        stationId: input.stationId ?? null,
      })
      .returning();
    if (!row) throw new Error("Could not record the expense.");

    await tx.insert(auditLog).values({
      action: "expense.record",
      entityTable: "expenses",
      entityId: row.id,
      payload: { category: category.nameTg, amountD: input.amountD, note: input.note ?? null },
      actorId: input.recordedBy,
      stationId: input.stationId ?? null,
      occurredAt,
    });

    return { expenseId: row.id, replayed: false as const };
  });
}

export interface ExpenseRow {
  id: string;
  categoryId: string;
  categoryName: string;
  amountD: number;
  note: string | null;
  occurredAt: Date;
  recordedByName: string;
}

/** Recent expenses, newest first — the list an owner or cashier scans to see what left
 * the drawer that was not cotton. */
export async function recentExpenses(limit = 30): Promise<ExpenseRow[]> {
  return await db
    .select({
      id: expenses.id,
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.nameTg,
      amountD: expenses.amountD,
      note: expenses.note,
      occurredAt: expenses.occurredAt,
      recordedByName: users.fullName,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(users, eq(users.id, expenses.recordedBy))
    .where(isNull(expenses.reversedAt))
    .orderBy(desc(expenses.occurredAt))
    .limit(limit);
}

/** Season-to-date total by category — the breakdown "properly set up accounting" means:
 * payroll against kitchen against maintenance, not one lump "expenses" figure. */
export async function expenseTotalsByCategory(since: Date) {
  const rows = await db
    .select({
      categoryId: expenseCategories.id,
      categoryName: expenseCategories.nameTg,
      amountD: expenses.amountD,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .where(and(gte(expenses.occurredAt, since), isNull(expenses.reversedAt)));

  const byCategory = new Map<string, { categoryName: string; totalD: number }>();
  for (const r of rows) {
    const existing = byCategory.get(r.categoryId);
    if (existing) existing.totalD += r.amountD;
    else byCategory.set(r.categoryId, { categoryName: r.categoryName, totalD: r.amountD });
  }
  return [...byCategory.values()].sort((a, b) => b.totalD - a.totalD);
}
