import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  ledgerEntries,
  ledgerTx,
  payments,
  serialBlocks,
  weighEvents,
  weighTickets,
} from "@/db/schema/index";
import { netWeight } from "@/domain/weight";

/**
 * Integrity checks the owner can run at any time.
 *
 * Append-only tables and unique constraints stop the obvious frauds. These checks catch
 * the rest: somebody with database access editing a row directly, a bug that lets a
 * snapshot drift from its events, or paper that has quietly gone missing. Everything
 * here recomputes from source rows — none of it trusts a stored summary.
 *
 * A clean result is not a guarantee of honesty. A dirty one is evidence of a problem.
 */

export interface Finding {
  check: string;
  /** Tajik, for the owner's screen. */
  titleTg: string;
  severity: "alarm" | "warn";
  detail: string;
  reference?: string;
}

/** Every posted transaction's entries must sum to zero. */
export async function verifyLedgerBalanced(): Promise<Finding[]> {
  const rows = await db
    .select({
      txId: ledgerTx.id,
      memo: ledgerTx.memo,
      total: raw<string>`SUM(${ledgerEntries.amountD})`,
    })
    .from(ledgerTx)
    .leftJoin(ledgerEntries, eq(ledgerEntries.txId, ledgerTx.id))
    .groupBy(ledgerTx.id, ledgerTx.memo)
    .having(raw`COALESCE(SUM(${ledgerEntries.amountD}), 0) <> 0`);

  return rows.map((r) => ({
    check: "ledger.balanced",
    titleTg: "Дафтари муҳосибӣ мувозина нест",
    severity: "alarm" as const,
    detail: `Transaction sums to ${r.total} diram instead of 0.`,
    reference: r.memo ?? r.txId,
  }));
}

/**
 * The gross/tare/net columns on a ticket are a snapshot for querying; the append-only
 * weigh events are the truth. If they disagree, someone or something wrote to the
 * snapshot directly.
 */
export async function verifyTicketWeights(): Promise<Finding[]> {
  const tickets = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      grossG: weighTickets.grossG,
      tareG: weighTickets.tareG,
      netG: weighTickets.netG,
      status: weighTickets.status,
    })
    .from(weighTickets)
    .where(raw`${weighTickets.status} <> 'VOID'`);

  const events = await db
    .select({
      ticketId: weighEvents.ticketId,
      id: weighEvents.id,
      kind: weighEvents.kind,
      weightG: weighEvents.weightG,
      supersedesId: weighEvents.supersedesId,
      recordedAt: weighEvents.recordedAt,
    })
    .from(weighEvents);

  const byTicket = new Map<string, typeof events>();
  for (const e of events) {
    const list = byTicket.get(e.ticketId) ?? [];
    list.push(e);
    byTicket.set(e.ticketId, list);
  }

  const findings: Finding[] = [];

  for (const t of tickets) {
    const list = (byTicket.get(t.id) ?? [])
      .slice()
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
    const superseded = new Set(list.map((e) => e.supersedesId).filter(Boolean) as string[]);
    const live = (kind: "GROSS" | "TARE") =>
      list.find((e) => e.kind === kind && !superseded.has(e.id))?.weightG ?? null;

    const gross = live("GROSS");
    const tare = live("TARE");

    if (t.grossG !== gross || t.tareG !== tare) {
      findings.push({
        check: "ticket.weights",
        titleTg: "Вазни борхат ба қайдҳо мувофиқ нест",
        severity: "alarm",
        detail:
          `Ticket shows ${t.grossG}/${t.tareG} g but the weighing record says ${gross}/${tare} g.`,
        reference: t.serial,
      });
      continue;
    }

    const expectedNet = gross !== null && tare !== null && tare < gross ? netWeight(gross, tare) : null;
    if (t.netG !== expectedNet) {
      findings.push({
        check: "ticket.net",
        titleTg: "Нетто нодуруст ҳисоб шудааст",
        severity: "alarm",
        detail: `Ticket shows нетто ${t.netG} g; брутто − тара gives ${expectedNet} g.`,
        reference: t.serial,
      });
    }
  }

  return findings;
}

/** Each payment's frozen amounts must equal what its ledger transaction actually posted. */
export async function verifyPaymentsAgainstLedger(): Promise<Finding[]> {
  const rows = await db
    .select({
      invoiceNo: payments.invoiceNo,
      grossAmountD: payments.grossAmountD,
      cashPayableD: payments.cashPayableD,
      advanceOffsetD: payments.advanceOffsetD,
      posted: raw<string>`COALESCE((
        SELECT SUM(ABS(e.amount_d)) FROM ledger_entries e WHERE e.tx_id = ${payments.ledgerTxId}
      ), 0)`,
    })
    .from(payments)
    .where(raw`${payments.reversedAt} IS NULL`);

  const findings: Finding[] = [];
  for (const p of rows) {
    // Debit the purchase, credit cash and/or the advance: the absolute values total twice
    // the gross, because every diram appears once on each side.
    const expected = p.grossAmountD * 2;
    if (Number(p.posted) !== expected) {
      findings.push({
        check: "payment.ledger",
        titleTg: "Пардохт ба дафтари муҳосибӣ мувофиқ нест",
        severity: "alarm",
        detail: `Payment records ${p.grossAmountD} diram; the ledger posted ${Number(p.posted) / 2}.`,
        reference: p.invoiceNo,
      });
    }
    if (p.cashPayableD + p.advanceOffsetD !== p.grossAmountD) {
      findings.push({
        check: "payment.split",
        titleTg: "Ҷамъи пардохт нодуруст аст",
        severity: "alarm",
        detail:
          `Cash ${p.cashPayableD} + advance ${p.advanceOffsetD} != gross ${p.grossAmountD}.`,
        reference: p.invoiceNo,
      });
    }
  }
  return findings;
}

/**
 * Ticket serials are handed out in contiguous blocks. A serial that was drawn but never
 * became a ticket is missing paper — it must be accounted for, not ignored.
 */
export async function verifySerialGaps(season: number): Promise<Finding[]> {
  const blocks = await db
    .select()
    .from(serialBlocks)
    .where(eq(serialBlocks.season, season));

  const findings: Finding[] = [];

  for (const block of blocks) {
    const used = await db
      .select({ n: weighTickets.serialNumber })
      .from(weighTickets)
      .where(
        and(
          eq(weighTickets.stationId, block.stationId),
          eq(weighTickets.season, season),
          raw`${weighTickets.serialNumber} >= ${block.rangeStart}`,
          raw`${weighTickets.serialNumber} < ${block.nextSerial}`,
        ),
      );

    const present = new Set(used.map((u) => u.n));
    const missing: number[] = [];
    for (let n = block.rangeStart; n < block.nextSerial; n++) {
      if (!present.has(n)) missing.push(n);
    }

    if (missing.length > 0) {
      findings.push({
        check: "serial.gap",
        titleTg: "Рақами борхат истифода нашудааст",
        severity: "warn",
        detail:
          `${missing.length} serial number(s) were issued but no ticket exists for them: ` +
          `${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}.`,
        reference: `${block.rangeStart}–${block.nextSerial - 1}`,
      });
    }
  }

  return findings;
}

export async function runAllChecks(season: number): Promise<Finding[]> {
  const results = await Promise.all([
    verifyLedgerBalanced(),
    verifyTicketWeights(),
    verifyPaymentsAgainstLedger(),
    verifySerialGaps(season),
  ]);
  return results.flat();
}
