import { db } from "@/db/client";
import { advances, auditLog, counterparties, ledgerEntries, ledgerTx } from "@/db/schema/index";
import { eq } from "drizzle-orm";
import { DomainError } from "@/domain/units";
import { buildAdvanceIssuedTx } from "@/domain/ledger";
import { advanceAccountIdFor, primaryCashAccountId } from "./balances";

export interface IssueAdvanceInput {
  clientUuid: string;
  counterpartyId: string;
  principalD: number;
  purpose?: string;
  issuedBy: string;
  stationId?: string;
  issuedAt?: Date;
}

/**
 * Қарз — cash to a farm before it sells, usually to pay the pickers.
 *
 * The money leaves the drawer and lands on the farm's advance account; it is recovered
 * from whatever that farm is later paid for cotton. Both sides are one balanced
 * transaction, so the cash can never leave without the receivable appearing.
 * docs/domain.md §4.
 */
export async function issueAdvance(input: IssueAdvanceInput) {
  const [replay] = await db
    .select()
    .from(advances)
    .where(eq(advances.clientUuid, input.clientUuid))
    .limit(1);
  if (replay) return { advanceId: replay.id, principalD: replay.principalD, replayed: true };

  if (input.principalD <= 0) {
    throw new DomainError("Маблағи қарз бояд аз сифр зиёд бошад. / An advance must be positive.");
  }

  return await db.transaction(async (tx) => {
    const [farm] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, input.counterpartyId))
      .limit(1);
    if (!farm) throw new DomainError("Хоҷагӣ ёфт нашуд. / Counterparty not found.");

    const cashAccountId = await primaryCashAccountId();
    const advanceAccountId = await advanceAccountIdFor(farm.id, farm.name);
    const issuedAt = input.issuedAt ?? new Date();

    const draft = buildAdvanceIssuedTx(
      input.principalD,
      { cashAccountId, advanceAccountId },
      `${input.purpose?.trim() || "Қарз"} — ${farm.name}`,
    );

    const [postedTx] = await tx
      .insert(ledgerTx)
      .values({
        clientUuid: input.clientUuid,
        kind: "ADVANCE_ISSUED",
        occurredAt: issuedAt,
        memo: draft.memo,
        createdBy: input.issuedBy,
        stationId: input.stationId ?? null,
      })
      .returning();
    if (!postedTx) throw new Error("Could not post the advance.");

    await tx.insert(ledgerEntries).values(
      draft.entries.map((e) => ({ txId: postedTx.id, accountId: e.accountId, amountD: e.amountD })),
    );

    const [row] = await tx
      .insert(advances)
      .values({
        clientUuid: input.clientUuid,
        counterpartyId: farm.id,
        principalD: input.principalD,
        issuedAt,
        purpose: input.purpose?.trim() ?? null,
        ledgerTxId: postedTx.id,
        issuedBy: input.issuedBy,
      })
      .returning();
    if (!row) throw new Error("Could not record the advance.");

    await tx.insert(auditLog).values({
      action: "advance.issue",
      entityTable: "advances",
      entityId: row.id,
      payload: { farm: farm.name, principalD: input.principalD, purpose: input.purpose ?? null },
      actorId: input.issuedBy,
      actorRole: "cashier",
      stationId: input.stationId ?? null,
      occurredAt: issuedAt,
    });

    return { advanceId: row.id, principalD: row.principalD, replayed: false };
  });
}
