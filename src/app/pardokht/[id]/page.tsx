import { notFound, redirect } from "next/navigation";
import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  batches,
  counterparties,
  payments,
  users,
  weighTickets,
} from "@/db/schema/index";
import { currentUser } from "@/lib/auth/session";
import { bpToPercentString, diramToSomoniString, gramsToKgString } from "@/domain/units";
import { outstandingAdvanceD } from "@/server/services/balances";
import { tg } from "@/lib/i18n/tg";
import { PrintButton } from "./print-button";
import {
  PrintCopy,
  PrintField,
  PrintFields,
  PrintIdentity,
  PrintPage,
  PrintSheet,
  PrintSignature,
  PrintSignatures,
  PrintWarning,
} from "@/components/print";

export const dynamic = "force-dynamic";

/**
 * Ҳисобномаи пардохт — the receipt for cash handed to a farmer.
 *
 * The cashier gives away money and takes in the farmer's stamped copy; both sides need
 * paper saying what was paid and how it was worked out. Three copies: хазина, корхона,
 * and the farmer's own, which shows the deduction and any advance recovered so the
 * arithmetic can be checked away from the desk.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/vorud");

  const { id } = await params;

  const [p] = await db
    .select({
      id: payments.id,
      invoiceNo: payments.invoiceNo,
      paidAt: payments.paidAt,
      netG: payments.netG,
      deductionBp: payments.deductionBp,
      payableG: payments.payableG,
      priceDPerKg: payments.priceDPerKg,
      grossAmountD: payments.grossAmountD,
      advanceOffsetD: payments.advanceOffsetD,
      cashPayableD: payments.cashPayableD,
      copyCollected: payments.copyCollected,
      reversedAt: payments.reversedAt,
      farmId: counterparties.id,
      farm: counterparties.name,
      tin: counterparties.tin,
      serial: weighTickets.serial,
      season: weighTickets.season,
      batchNumber: batches.number,
      cashier: users.fullName,
    })
    .from(payments)
    .innerJoin(counterparties, eq(counterparties.id, payments.counterpartyId))
    .innerJoin(weighTickets, eq(weighTickets.id, payments.ticketId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .leftJoin(users, eq(users.id, payments.paidBy))
    .where(eq(payments.id, id))
    .limit(1);

  if (!p) notFound();

  const remainingAdvanceD = await outstandingAdvanceD(p.farmId);

  const [printed] = await db
    .select({ n: raw<string>`COUNT(*)` })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, p.id), eq(auditLog.action, "payment.print")));
  const printCount = Number(printed?.n ?? 0);

  const copies = [tg.cash.copyCash, tg.cash.copyFactory2, tg.cash.copyFarm];
  const when = p.paidAt.toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return (
    <PrintPage>
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] items-center gap-3 px-4">
        <a href="/hazina" className="btn-secondary">{tg.common.back}</a>
        <span className="font-mono text-brand">{p.invoiceNo}</span>
        {printCount > 0 && (
          <span className="badge bg-amber-100 text-warn">
            {tg.ticket.printedTimes}: {printCount}
          </span>
        )}
        <PrintButton paymentId={p.id} alreadyPrinted={printCount} />
      </div>
      <p className="no-print mx-auto mb-3 max-w-[210mm] px-4 text-sm text-ink-soft">
        {tg.ticket.printHint}
      </p>

      <PrintSheet>
        {copies.map((label, i) => (
          <PrintCopy
            key={label}
            formCode={tg.cash.invoice}
            title={tg.cash.receiptTitle}
            serialLabel={tg.cash.receiptNo}
            serialValue={p.invoiceNo}
            copyLabel={label}
            cutAbove={i > 0}
            right={
              <PrintIdentity season={p.season} batchNumber={p.batchNumber} serial={p.serial} />
            }
          >
            <PrintFields>
              <PrintField label={tg.ticket.date} value={when} />
              <PrintField label={tg.ticket.number} value={p.serial} />
              <PrintField label={tg.ticket.consignor} value={p.farm} />
              <PrintField label={tg.ticket.tin} value={p.tin} />
            </PrintFields>

            <table className="mt-2 w-full border-collapse">
              <tbody className="tabular">
                <Row label={tg.ticket.net} value={`${gramsToKgString(p.netG, 1)} ${tg.common.kg}`} />
                <Row label={tg.lab.deduction} value={`${bpToPercentString(p.deductionBp)} %`} />
                <Row label={tg.cash.payable}
                     value={`${gramsToKgString(p.payableG, 2)} ${tg.common.kg}`} />
                <Row label={tg.cash.price}
                     value={`${diramToSomoniString(p.priceDPerKg)} ${tg.price.perKg}`} />
                <Row label={tg.cash.grossAmount}
                     value={`${diramToSomoniString(p.grossAmountD)} ${tg.common.somoni}`} strong />
                {p.advanceOffsetD > 0 && (
                  <Row label={tg.cash.advanceOffset}
                       value={`− ${diramToSomoniString(p.advanceOffsetD)} ${tg.common.somoni}`} />
                )}
                <Row
                  label={tg.cash.cashToPay}
                  value={`${diramToSomoniString(p.cashPayableD)} ${tg.common.somoni}`}
                  big
                />
                {remainingAdvanceD > 0 && (
                  <Row label={tg.cash.remainingAdvance}
                       value={`${diramToSomoniString(remainingAdvanceD)} ${tg.common.somoni}`} />
                )}
              </tbody>
            </table>

            {p.reversedAt && <PrintWarning>{tg.common.voidAction}</PrintWarning>}

            <PrintSignatures>
              <PrintSignature label={tg.cash.paidBy} name={p.cashier} />
              <PrintSignature
                label={`${tg.cash.paidTo} — ${tg.cash.receivedSignature}`}
                name={p.farm}
              />
            </PrintSignatures>
          </PrintCopy>
        ))}
      </PrintSheet>
    </PrintPage>
  );
}

function Row({
  label, value, strong, big,
}: { label: string; value: string; strong?: boolean; big?: boolean }) {
  return (
    <tr className={big ? "bg-brand-light" : ""}>
      <td className="border border-ink-faint px-2 py-0.5 text-ink-soft">{label}</td>
      <td
        className={`px-2 py-0.5 text-end ${
          big ? "print-net border-2 border-ink text-sm font-bold" : "border border-ink-faint"
        } ${strong && !big ? "font-semibold" : ""}`}
      >
        {value}
      </td>
    </tr>
  );
}

function Signature({ label, name }: { label: string; name: string | null }) {
  return (
    <div>
      <div className="h-5 border-b border-ink-faint" />
      <div className="mt-0.5 text-ink-faint">{label}</div>
      <div className="font-medium">{name ?? " "}</div>
    </div>
  );
}
