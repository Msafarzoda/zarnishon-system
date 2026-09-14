import { notFound } from "next/navigation";
import { and, desc, eq, ne, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  advances,
  batches,
  counterparties,
  payments,
  users,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { bpToPercentString, diramToSomoniString, divRound, gramsToKgString } from "@/domain/units";
import { payableWeight } from "@/domain/weight";
import { outstandingAdvanceD } from "@/server/services/balances";
import { priceTrend } from "@/server/services/price-trend";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { PriceTrendStat } from "@/components/price-trend";

export const dynamic = "force-dynamic";

/**
 * Ҳисоби хоҷагӣ — one customer's account.
 *
 * A farm delivers many truckloads over a season and is paid for them one at a time,
 * whenever it chooses. The cashier is also the bookkeeper here, so this is the page that
 * answers the questions actually asked at the desk: how much has this farm brought in,
 * what has it already been paid, what does it still have coming, and what does it owe us
 * in advances.
 *
 * What we owe is carried in **kilograms**, not money — the price is only fixed on the day
 * a farmer decides to be paid. The somoni figure is today's valuation, not a debt.
 */
export default async function FarmAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageRole(
    "cashier", "accountant", "owner", "merchandiser", "admin",
  );
  const { id } = await params;

  const [farm] = await db
    .select()
    .from(counterparties)
    .where(eq(counterparties.id, id))
    .limit(1);
  if (!farm) notFound();

  // Every load this farm has brought in, with the deduction its own lab sample produced
  // (falling back to a партия certificate) and the payment if there is one.
  const tickets = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      status: weighTickets.status,
      netG: weighTickets.netG,
      weighedAt: weighTickets.weighedAt,
      createdAt: weighTickets.createdAt,
      plate: vehicles.plate,
      batchNumber: batches.number,
      deductionBp: raw<number | null>`COALESCE(
        (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
           FROM lab_analyses la
          WHERE la.ticket_id = weigh_tickets.id
            AND la.stage = 'on_intake' AND la.status = 'APPROVED'
            AND la.superseded_at IS NULL
          LIMIT 1),
        (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
           FROM lab_analyses la
          WHERE la.batch_id = weigh_tickets.batch_id
            AND la.stage = 'on_intake' AND la.status = 'APPROVED'
            AND la.superseded_at IS NULL
          LIMIT 1)
      )`,
      paymentId: payments.id,
      cashPayableD: payments.cashPayableD,
      grossAmountD: payments.grossAmountD,
      paidAt: payments.paidAt,
    })
    .from(weighTickets)
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .leftJoin(payments, eq(payments.ticketId, weighTickets.id))
    .where(and(eq(weighTickets.consignorId, farm.id), ne(weighTickets.status, "VOID")))
    .orderBy(desc(weighTickets.createdAt));

  const advanceRows = await db
    .select({
      id: advances.id,
      principalD: advances.principalD,
      issuedAt: advances.issuedAt,
      purpose: advances.purpose,
      issuedBy: users.fullName,
    })
    .from(advances)
    .leftJoin(users, eq(users.id, advances.issuedBy))
    .where(eq(advances.counterpartyId, farm.id))
    .orderBy(desc(advances.issuedAt));

  const advanceOutstandingD = await outstandingAdvanceD(farm.id);

  // The farm is watching this number, not the weight: it decides when to be paid.
  const trend = await priceTrend();
  const priceDPerKg = trend.currentD;

  // Totals, computed with the same tested functions the cash desk settles with.
  let deliveredG = 0;
  let payableG = 0;
  let unpaidPayableG = 0;
  let paidCashD = 0;
  let paidGrossD = 0;
  const stage = { scale: 0, lab: 0, ready: 0, paid: 0 };

  for (const t of tickets) {
    const net = t.netG ?? 0;
    deliveredG += net;

    if (t.status === "OPEN" || t.status === "DRAFT") stage.scale += 1;
    else if (t.status === "WEIGHED") stage.lab += 1;
    else if (t.status === "ANALYSED") stage.ready += 1;
    else if (t.status === "PAID") stage.paid += 1;

    if (t.deductionBp !== null) {
      const p = payableWeight(net, Number(t.deductionBp));
      payableG += p;
      if (t.status === "ANALYSED") unpaidPayableG += p;
    }
    if (t.paymentId) {
      paidCashD += t.cashPayableD ?? 0;
      paidGrossD += t.grossAmountD ?? 0;
    }
  }

  const owedValueD =
    priceDPerKg !== null ? divRound(unpaidPayableG * priceDPerKg, 1000) : null;

  const kg = (g: number) => `${gramsToKgString(g, 1)} ${tg.common.kg}`;
  const som = (d: number) => `${diramToSomoniString(d)} ${tg.common.somoni}`;

  return (
    <Shell user={user} title={`${tg.nav.account} — ${farm.name}`}>
      <div className="space-y-5">
        <section className="card px-4 py-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-ink-soft">
            {farm.tin && <span>{tg.ticket.tin}: <strong className="text-ink tabular">{farm.tin}</strong></span>}
            {farm.defaultLocation && <span>{tg.ticket.loadingPlace}: <strong className="text-ink">{farm.defaultLocation}</strong></span>}
            {farm.phone && (
              <span>
                {tg.common.phone}:{" "}
                <a href={`tel:${farm.phone}`} className="font-medium text-brand hover:underline">
                  {farm.phone}
                </a>
              </span>
            )}
          </div>
        </section>

        {unpaidPayableG > 0 && (
          <section className="grid gap-4 sm:grid-cols-2">
            <PriceTrendStat trend={trend} />
            <div className="card border-brand bg-brand-light px-4 py-3">
              <div className="text-sm text-brand-dark">{tg.cash.worthToday}</div>
              <div className="tabular text-2xl font-bold leading-tight text-brand-dark">
                {owedValueD !== null ? som(owedValueD) : "—"}
              </div>
              <div className="mt-1 text-xs text-brand-dark/70">
                {kg(unpaidPayableG)} · {tg.cash.waitingByChoice}
              </div>
            </div>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Tile label={tg.account.delivered} value={kg(deliveredG)}
                hint={`${tickets.length} × ${tg.ticket.title}`} />
          <Tile label={tg.account.payableWeight} value={kg(payableG)} />
          <Tile label={tg.account.paidTotal} value={som(paidCashD)}
                hint={`${stage.paid} × ${tg.ticket.title}`} />
          <Tile
            label={tg.account.owedWeight}
            value={kg(unpaidPayableG)}
            hint={owedValueD !== null ? `≈ ${som(owedValueD)}` : undefined}
            accent={unpaidPayableG > 0}
          />
          <Tile
            label={tg.account.advanceOutstanding}
            value={som(advanceOutstandingD)}
            tone={advanceOutstandingD > 0 ? "warn" : undefined}
          />
        </section>

        <p className="text-xs text-ink-faint">{tg.account.valuedAtToday}</p>

        {(stage.scale > 0 || stage.lab > 0 || stage.ready > 0) && (
          <section className="flex flex-wrap gap-2 text-sm">
            {stage.scale > 0 && <Chip label={tg.account.awaitingScale} n={stage.scale} />}
            {stage.lab > 0 && <Chip label={tg.account.awaitingLab} n={stage.lab} warn />}
            {stage.ready > 0 && <Chip label={tg.account.readyToPay} n={stage.ready} ready />}
          </section>
        )}

        <section className="card overflow-x-auto p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.account.ticketsTitle}</h2>
          <table className="w-full text-sm">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1 text-start font-medium">{tg.ticket.date}</th>
                <th className="py-1 text-start font-medium">{tg.ticket.number}</th>
                <th className="py-1 text-start font-medium">{tg.ticket.vehicle}</th>
                <th className="py-1 text-end font-medium">{tg.ticket.net}</th>
                <th className="py-1 text-end font-medium">{tg.lab.deduction}</th>
                <th className="py-1 text-end font-medium">{tg.cash.payable}</th>
                <th className="py-1 text-end font-medium">{tg.cash.cashToPay}</th>
                <th className="py-1 text-start font-medium ps-3">{tg.ticketStatus.PAID}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {tickets.map((t) => {
                const net = t.netG ?? 0;
                const d = t.deductionBp === null ? null : Number(t.deductionBp);
                return (
                  <tr key={t.id}>
                    <td className="py-1.5 tabular text-ink-faint">
                      {(t.weighedAt ?? t.createdAt).toLocaleDateString("ru-RU")}
                    </td>
                    <td className="py-1.5">
                      <a href={`/borkhat/${t.id}`} className="font-mono text-brand hover:underline">
                        {t.serial}
                      </a>
                    </td>
                    <td className="py-1.5 tabular text-ink-soft">{t.plate ?? "—"}</td>
                    <td className="py-1.5 text-end tabular">{gramsToKgString(net, 1)}</td>
                    <td className="py-1.5 text-end tabular">
                      {d === null ? "—" : `${bpToPercentString(d)} %`}
                    </td>
                    <td className="py-1.5 text-end tabular">
                      {d === null ? "—" : gramsToKgString(payableWeight(net, d), 1)}
                    </td>
                    <td className="py-1.5 text-end tabular font-semibold">
                      {t.cashPayableD !== null ? diramToSomoniString(t.cashPayableD) : "—"}
                    </td>
                    <td className="py-1.5 ps-3">
                      {t.paymentId ? (
                        <a href={`/pardokht/${t.paymentId}`} className="text-brand hover:underline">
                          {t.paidAt?.toLocaleDateString("ru-RU")}
                        </a>
                      ) : (
                        <span className="badge bg-paper text-ink-soft">
                          {tg.ticketStatus[t.status as keyof typeof tg.ticketStatus]}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {tickets.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-ink-faint">
                  {tg.account.noTickets}
                </td></tr>
              )}
            </tbody>
          </table>
        </section>

        {advanceRows.length > 0 && (
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.account.advancesTitle}</h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-paper-line">
                {advanceRows.map((a) => (
                  <tr key={a.id}>
                    <td className="py-1.5 tabular text-ink-faint">
                      {a.issuedAt.toLocaleDateString("ru-RU")}
                    </td>
                    <td className="py-1.5">{a.purpose ?? tg.advance.title}</td>
                    <td className="py-1.5 text-end tabular font-semibold">
                      {diramToSomoniString(a.principalD)}
                    </td>
                    <td className="py-1.5 text-end text-ink-faint">{a.issuedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-end text-sm">
              {tg.account.advanceOutstanding}:{" "}
              <strong className="tabular text-warn">{som(advanceOutstandingD)}</strong>
            </p>
          </section>
        )}
      </div>
    </Shell>
  );
}

function Tile({
  label, value, hint, accent, tone,
}: { label: string; value: string; hint?: string; accent?: boolean; tone?: "warn" }) {
  return (
    <div className={`card px-4 py-3 ${accent ? "border-brand bg-brand-light" : ""}`}>
      <div className={`text-sm ${accent ? "text-brand-dark" : "text-ink-soft"}`}>{label}</div>
      <div
        className={`tabular text-xl font-bold ${
          tone === "warn" ? "text-warn" : accent ? "text-brand-dark" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

function Chip({ label, n, warn, ready }: { label: string; n: number; warn?: boolean; ready?: boolean }) {
  return (
    <span
      className={`badge ${
        ready ? "bg-brand-light text-brand-dark" : warn ? "bg-amber-100 text-warn" : "bg-paper text-ink-soft"
      }`}
    >
      {label}: {n}
    </span>
  );
}
