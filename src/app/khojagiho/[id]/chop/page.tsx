import { notFound } from "next/navigation";
import { requirePageRole } from "@/lib/auth/session";
import { diramToSomoniString, gramsToKgString } from "@/domain/units";
import { farmStatement } from "@/server/services/farm-statement";
import { priceTrend } from "@/server/services/price-trend";
import { tg } from "@/lib/i18n/tg";
import { FarmStatementTable } from "@/components/farm-statement-table";
import { FACTORY } from "@/components/print";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * The farm's account on paper.
 *
 * A farmer who has delivered twenty loads and taken three advances cannot hold that in
 * his head, and neither can the cashier. This is the page he takes away: every movement
 * in date order, the price each load was paid at, what was recovered against his
 * advances, and what is still his.
 *
 * Unlike the Борхат and the receipt, this is one continuous sheet rather than three
 * copies — a statement is a record, not a bearer instrument, and it runs to whatever
 * length the season needs.
 */
export default async function FarmStatementPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageRole("cashier", "accountant", "owner", "merchandiser", "admin");
  const { id } = await params;

  const trend = await priceTrend();
  const s = await farmStatement(id, trend.currentD);
  if (!s) notFound();

  const kg = (g: number) => `${gramsToKgString(g, 1)} ${tg.common.kg}`;
  const som = (d: number) => `${diramToSomoniString(d)} ${tg.common.somoni}`;
  const printedAt = new Date();

  return (
    <div className="min-h-screen bg-paper py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-3 flex max-w-[260mm] items-center gap-3 px-4">
        <a href={`/khojagiho/${id}`} className="btn-secondary">{tg.common.back}</a>
        <span className="font-medium">{s.farm.name}</span>
        <PrintButton />
      </div>
      <p className="no-print mx-auto mb-3 max-w-[260mm] px-4 text-sm text-ink-soft">
        {tg.ticket.printHint}
      </p>

      <div className="mx-auto max-w-[260mm] px-4 print:max-w-none print:px-0">
        <article className="card bg-white p-5 text-[12px] print:border-0 print:shadow-none">
          <header className="mb-3 flex items-start justify-between gap-4 border-b-2 border-ink pb-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-faint">
                {FACTORY}
              </div>
              <h1 className="text-base font-bold uppercase tracking-wide">
                {tg.account.statement}
              </h1>
              <div className="mt-0.5 text-sm font-semibold">{s.farm.name}</div>
              <div className="text-[11px] text-ink-soft">
                {s.farm.tin && <>{tg.ticket.tin}: {s.farm.tin}</>}
                {s.farm.place && <> · {s.farm.place}</>}
                {s.farm.phone && <> · {s.farm.phone}</>}
              </div>
            </div>
            <div className="text-end text-[11px] text-ink-faint">
              <div>
                {tg.ticket.printedAtLabel}:{" "}
                {printedAt.toLocaleString("ru-RU", {
                  day: "2-digit", month: "2-digit", year: "numeric",
                  hour: "2-digit", minute: "2-digit",
                })}
              </div>
              {s.priceDPerKg !== null && (
                <div className="mt-0.5">
                  {tg.cash.priceToday}:{" "}
                  <strong className="text-ink">{diramToSomoniString(s.priceDPerKg)}</strong>{" "}
                  {tg.price.perKg}
                </div>
              )}
            </div>
          </header>

          <section className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            <Fig label={tg.account.delivered} value={kg(s.deliveredG)} />
            <Fig label={tg.account.cashPaid} value={som(s.cashPaidD)} />
            <Fig label={tg.account.owedWeight} value={kg(s.unpaidPayableG)}
                 note={s.unpaidValueD !== null ? `≈ ${som(s.unpaidValueD)}` : undefined} />
            <Fig label={tg.account.advanceOutstanding} value={som(s.advanceOutstandingD)} />
          </section>

          <div className="overflow-x-auto">
            <FarmStatementTable rows={s.rows} />
          </div>

          <p className="mt-2 text-[10px] text-ink-faint">{tg.account.valuedAtToday}</p>

          <div className="mt-6 grid grid-cols-2 gap-8 text-[10px]">
            <Sign label={tg.cash.paidBy} />
            <Sign label={tg.ticket.consignor} name={s.farm.name} />
          </div>
        </article>
      </div>
    </div>
  );
}

function Fig({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border-b border-dotted border-paper-line py-0.5">
      <div className="text-[10px] text-ink-faint">{label}</div>
      <div className="tabular font-semibold">{value}</div>
      {note && <div className="tabular text-[10px] text-ink-soft">{note}</div>}
    </div>
  );
}

function Sign({ label, name }: { label: string; name?: string }) {
  return (
    <div>
      <div className="h-6 border-b border-ink" />
      <div className="mt-0.5 text-ink-faint">{label}</div>
      <div className="font-medium">{name ?? " "}</div>
    </div>
  );
}
