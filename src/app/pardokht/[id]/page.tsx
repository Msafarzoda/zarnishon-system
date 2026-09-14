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

export const dynamic = "force-dynamic";

const FACTORY = 'ЧДММ «ЗАРНИШОН»';

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
    <div className="borkhat-page min-h-screen bg-paper py-6">
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

      <div className="borkhat-sheet mx-auto max-w-[210mm] space-y-4 px-4">
        {copies.map((label, i) => (
          <article key={label} className="print-copy card relative bg-white p-4 text-[12px] leading-snug">
            {i > 0 && (
              <span className="absolute -top-2 left-3 bg-paper px-1 text-[10px] text-ink-faint print:bg-white">
                ✂ {tg.ticket.cutHere}
              </span>
            )}

            <header className="mb-2 flex items-start justify-between gap-3 border-b border-paper-line pb-1.5">
              <div>
                <div className="text-ink-faint">{FACTORY}</div>
                <h2 className="font-bold uppercase tracking-wide">
                  {tg.cash.receiptTitle}
                  <span className="ms-2 font-mono text-base">{p.invoiceNo}</span>
                </h2>
              </div>
              <div className="text-end">
                <div className="text-ink-faint">
                  {tg.app.season}-{p.season} · {tg.ticket.batch}{" "}
                  <strong className="text-ink">{p.batchNumber ?? "—"}</strong>
                </div>
                <div className="mt-0.5 font-semibold">{label}</div>
                <div className="font-mono text-[9px] text-ink-faint">{p.serial}</div>
              </div>
            </header>

            <div className="grid grid-cols-2 gap-x-5">
              <Field label={tg.ticket.date} value={when} />
              <Field label={tg.ticket.number} value={p.serial} />
              <Field label={tg.ticket.consignor} value={p.farm} />
              <Field label={tg.ticket.tin} value={p.tin} />
            </div>

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

            {p.reversedAt && (
              <p className="mt-1 border border-alarm/40 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-alarm">
                {tg.common.voidAction}
              </p>
            )}

            <div className="mt-3 grid grid-cols-2 gap-6 text-[9px]">
              <Signature label={tg.cash.paidBy} name={p.cashier} />
              <Signature label={`${tg.cash.paidTo} — ${tg.cash.receivedSignature}`} name={p.farm} />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2 border-b border-dotted border-paper-line py-px">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="ms-auto text-end font-medium">{value || "—"}</span>
    </div>
  );
}

function Row({
  label, value, strong, big,
}: { label: string; value: string; strong?: boolean; big?: boolean }) {
  return (
    <tr className={big ? "bg-brand-light" : ""}>
      <td className="border border-paper-line px-2 py-0.5 text-ink-soft">{label}</td>
      <td
        className={`border border-paper-line px-2 py-0.5 text-end ${
          big ? "print-net text-sm font-bold" : strong ? "font-semibold" : ""
        }`}
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
