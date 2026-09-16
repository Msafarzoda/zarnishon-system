import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { counterparties, disbursements, users } from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { diramToSomoniString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import {
  PrintCopy,
  PrintField,
  PrintFields,
  PrintPage,
  PrintSheet,
  PrintSignature,
  PrintSignatures,
  PrintWarning,
} from "@/components/print";
import { PlainPrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * Расиди пардохти нақдӣ — the receipt for an instalment.
 *
 * A farm that settled earlier and has come back for more of its money gets this. It is
 * deliberately short: who, how much today, and how much is left — no weights, no price,
 * no deduction, because none of that is being decided again. The борхат receipt already
 * settled all of it.
 *
 * **Two copies**, like the settlement receipt: хазина keeps one, the farm takes one.
 */
export default async function DisbursementReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageRole("cashier", "accountant", "owner", "admin");

  const { id } = await params;

  const [d] = await db
    .select({
      id: disbursements.id,
      receiptNo: disbursements.receiptNo,
      amountD: disbursements.amountD,
      balanceAfterD: disbursements.balanceAfterD,
      note: disbursements.note,
      paidAt: disbursements.paidAt,
      reversedAt: disbursements.reversedAt,
      farm: counterparties.name,
      tin: counterparties.tin,
      cashier: users.fullName,
    })
    .from(disbursements)
    .innerJoin(counterparties, eq(counterparties.id, disbursements.counterpartyId))
    .leftJoin(users, eq(users.id, disbursements.paidBy))
    .where(eq(disbursements.id, id))
    .limit(1);

  if (!d) notFound();

  const when = d.paidAt.toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const copies = [tg.cash.copyCash, tg.cash.copyFarm];

  return (
    <PrintPage>
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] items-center gap-3 px-4">
        <a href="/hazina" className="btn-secondary">{tg.common.back}</a>
        <span className="font-mono text-brand">{d.receiptNo}</span>
        <PlainPrintButton />
      </div>

      <PrintSheet copies={2}>
        {copies.map((label, i) => (
          <PrintCopy
            key={label}
            formCode={tg.cash.disbursement}
            title={tg.cash.disbursementTitle}
            serialLabel={tg.cash.disbursementNo}
            serialValue={d.receiptNo}
            copyLabel={label}
            cutAbove={i > 0}
          >
            <PrintFields>
              <PrintField label={tg.ticket.date} value={when} />
              <PrintField label={tg.ticket.consignor} value={d.farm} />
              <PrintField label={tg.ticket.tin} value={d.tin} />
              <PrintField label={tg.common.note} value={d.note} />
            </PrintFields>

            <table className="mt-2 w-full border-collapse">
              <tbody className="tabular">
                <Row
                  label={tg.cash.paidNow}
                  value={`${diramToSomoniString(d.amountD)} ${tg.common.somoni}`}
                  big
                />
                {/* Why the farm keeps this paper. */}
                <Row
                  label={tg.cash.balanceAfter}
                  value={`${diramToSomoniString(d.balanceAfterD)} ${tg.common.somoni}`}
                  strong
                />
              </tbody>
            </table>

            {d.reversedAt && <PrintWarning>{tg.common.voidAction}</PrintWarning>}

            <PrintSignatures>
              <PrintSignature label={tg.cash.paidBy} name={d.cashier} />
              <PrintSignature
                label={`${tg.cash.paidTo} — ${tg.cash.receivedSignaturePartial}`}
                name={d.farm}
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
