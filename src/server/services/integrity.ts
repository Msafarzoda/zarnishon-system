import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  counterparties,
  disbursements,
  ledgerAccounts,
  ledgerEntries,
  ledgerTx,
  payments,
  serialBlocks,
  weighEvents,
  weighTickets,
} from "@/db/schema/index";
import { netWeight } from "@/domain/weight";
import { isPlausibleTin } from "@/domain/plate";

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

/**
 * Every posted transaction's entries must sum to zero — and there must be entries.
 *
 * Summing to zero is not enough on its own: a transaction whose entries have been removed
 * sums to zero too, because an empty sum is zero. That is money that moved and then lost
 * its record, which is exactly the kind of hole this check exists to find, and it passed
 * silently until a mis-ordered delete produced one.
 */
export async function verifyLedgerBalanced(): Promise<Finding[]> {
  const rows = await db
    .select({
      txId: ledgerTx.id,
      memo: ledgerTx.memo,
      total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)`,
      entries: raw<string>`COUNT(${ledgerEntries.id})`,
    })
    .from(ledgerTx)
    .leftJoin(ledgerEntries, eq(ledgerEntries.txId, ledgerTx.id))
    .groupBy(ledgerTx.id, ledgerTx.memo)
    .having(
      raw`COALESCE(SUM(${ledgerEntries.amountD}), 0) <> 0 OR COUNT(${ledgerEntries.id}) < 2`,
    );

  return rows.map((r) => {
    const entries = Number(r.entries);
    return {
      check: entries < 2 ? "ledger.incomplete" : "ledger.balanced",
      titleTg:
        entries < 2
          ? "Амалиёти муҳосибӣ нопурра аст"
          : "Дафтари муҳосибӣ мувозина нест",
      severity: "alarm" as const,
      detail:
        entries < 2
          ? `Transaction has ${entries} entr${entries === 1 ? "y" : "ies"}; every movement ` +
            `needs at least two sides.`
          : `Transaction sums to ${r.total} diram instead of 0.`,
      reference: r.memo ?? r.txId,
    };
  });
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
 * Cash handed to farms, checked both ways.
 *
 * A disbursement must post exactly what it says it posted, and no farm may end up having
 * been paid more than it was owed. The service refuses an over-payment inside the same
 * transaction it posts in, so a negative balance here means something reached the ledger
 * without going through it — which is exactly what this check exists to notice.
 */
export async function verifyDisbursements(): Promise<Finding[]> {
  const findings: Finding[] = [];

  const rows = await db
    .select({
      receiptNo: disbursements.receiptNo,
      amountD: disbursements.amountD,
      posted: raw<string>`COALESCE((
        SELECT SUM(ABS(e.amount_d)) FROM ledger_entries e WHERE e.tx_id = ${disbursements.ledgerTxId}
      ), 0)`,
    })
    .from(disbursements)
    .where(raw`${disbursements.reversedAt} IS NULL`);

  for (const d of rows) {
    // Every diram appears once as a debit and once as a credit.
    if (Number(d.posted) !== d.amountD * 2) {
      findings.push({
        check: "disbursement.ledger",
        titleTg: "Пардохти нақдӣ ба дафтари муҳосибӣ мувофиқ нест",
        severity: "alarm",
        detail: `Disbursement records ${d.amountD} diram; the ledger posted ${Number(d.posted) / 2}.`,
        reference: d.receiptNo,
      });
    }
  }

  // FARM_PAYABLE is credit-normal: a positive balance means we have handed over more than
  // we ever owed.
  const overpaid = await db
    .select({
      farm: counterparties.name,
      balanceD: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)`,
    })
    .from(ledgerAccounts)
    .innerJoin(counterparties, eq(counterparties.id, ledgerAccounts.counterpartyId))
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerAccounts.kind, "FARM_PAYABLE"))
    .groupBy(counterparties.name)
    .having(raw`COALESCE(SUM(${ledgerEntries.amountD}), 0) > 0`);

  for (const f of overpaid) {
    findings.push({
      check: "farm.overpaid",
      titleTg: "Ба хоҷагӣ аз ҳисобаш зиёдтар пардохт шудааст",
      severity: "alarm",
      detail: `This farm has been paid ${Number(f.balanceD)} diram more than it was owed.`,
      reference: f.farm,
    });
  }

  return findings;
}

/**
 * Хоҷагиҳо бе РМА — farms that cannot be identified.
 *
 * The tax number is what makes a farm one farm across seasons and spellings. A record
 * without a usable one cannot be matched against the next waybill that arrives, so it
 * quietly becomes a second farm holding half the history. Warned about rather than
 * alarmed: it is bad data, not missing money — but it needs fixing before the number is
 * relied on to find anybody.
 */
export async function verifyFarmIdentity(): Promise<Finding[]> {
  const rows = await db
    .select({ id: counterparties.id, name: counterparties.name, tin: counterparties.tin })
    .from(counterparties)
    .where(and(eq(counterparties.kind, "farm"), eq(counterparties.isActive, true)));

  return rows
    .filter((f) => !f.tin || !isPlausibleTin(f.tin))
    .map((f) => ({
      check: "farm.tin",
      titleTg: "Хоҷагӣ РМА-и дуруст надорад",
      severity: "warn" as const,
      detail: f.tin
        ? `"${f.tin}" is not a usable taxpayer number; this farm cannot be matched reliably.`
        : "This farm has no taxpayer number, so it cannot be matched against future loads.",
      reference: f.name,
    }));
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
    verifyDisbursements(),
    verifyFarmIdentity(),
    verifySerialGaps(season),
  ]);
  return results.flat();
}
