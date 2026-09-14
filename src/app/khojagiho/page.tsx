import { asc, desc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  counterparties,
  drivers,
  ledgerAccounts,
  ledgerEntries,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { diramToSomoniString, gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { AddForms } from "./add-forms";

export const dynamic = "force-dynamic";

export default async function FarmsPage() {
  const user = await requirePageRole("merchandiser", "cashier", "owner", "accountant", "admin");

  // Each farm with what it still owes us and what we still owe it, both derived.
  const farms = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      tin: counterparties.tin,
      place: counterparties.defaultLocation,
      phone: counterparties.phone,
      // Interpolating a Drizzle column into a raw template renders it UNQUALIFIED
      // ("id"), which collides with ledger_accounts.id inside these correlated
      // subqueries — Postgres rejects the whole query as ambiguous. The outer table is
      // named explicitly instead.
      advanceD: raw<string>`COALESCE((
        SELECT SUM(e.amount_d) FROM ledger_entries e
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'ADVANCE_RECEIVABLE' AND a.counterparty_id = counterparties.id
      ), 0)`,
      unpaidTickets: raw<string>`COALESCE((
        SELECT COUNT(*) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status = 'ANALYSED'
      ), 0)`,
      deliveredG: raw<string>`COALESCE((
        SELECT SUM(t.net_g) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status <> 'VOID'
      ), 0)`,
      paidD: raw<string>`COALESCE((
        SELECT SUM(p.cash_payable_d) FROM payments p
        WHERE p.counterparty_id = counterparties.id AND p.reversed_at IS NULL
      ), 0)`,
    })
    .from(counterparties)
    .where(eq(counterparties.isActive, true))
    .orderBy(asc(counterparties.name));

  const [vehicleList, driverList] = await Promise.all([
    db.select({ id: vehicles.id, plate: vehicles.plate, model: vehicles.model })
      .from(vehicles).where(eq(vehicles.isActive, true)).orderBy(asc(vehicles.plate)).limit(100),
    db.select({ id: drivers.id, fullName: drivers.fullName })
      .from(drivers).where(eq(drivers.isActive, true)).orderBy(asc(drivers.fullName)).limit(100),
  ]);

  return (
    <Shell user={user} title={tg.nav.farms}>
      <div className="space-y-5">
        <AddForms />

        <section className="card overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1 text-start font-medium">{tg.ticket.consignor}</th>
                <th className="py-1 text-start font-medium">{tg.ticket.tin}</th>
                <th className="py-1 text-start font-medium">{tg.ticket.loadingPlace}</th>
                <th className="py-1 text-start font-medium">{tg.common.phone}</th>
                <th className="py-1 text-end font-medium">{tg.dashboard.cottonReceived}</th>
                <th className="py-1 text-end font-medium">{tg.account.paidTotal}</th>
                <th className="py-1 text-end font-medium">{tg.dashboard.unpaidTickets}</th>
                <th className="py-1 text-end font-medium">{tg.advance.outstanding}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {farms.map((f) => {
                const advance = Number(f.advanceD);
                return (
                  <tr key={f.id}>
                    <td className="py-2 font-medium">
                      <a href={`/khojagiho/${f.id}`} className="text-brand hover:underline">
                        {f.name}
                      </a>
                    </td>
                    <td className="py-2 tabular text-ink-soft">{f.tin ?? "—"}</td>
                    <td className="py-2 text-ink-soft">{f.place ?? "—"}</td>
                    <td className="py-2 tabular text-ink-soft">
                      {f.phone ? <a href={`tel:${f.phone}`} className="hover:underline">{f.phone}</a> : "—"}
                    </td>
                    <td className="py-2 text-end tabular">
                      {gramsToKgString(Number(f.deliveredG), 0)} {tg.common.kg}
                    </td>
                    <td className="py-2 text-end tabular">
                      {Number(f.paidD) > 0 ? diramToSomoniString(Number(f.paidD)) : "—"}
                    </td>
                    <td className="py-2 text-end tabular">{Number(f.unpaidTickets) || "—"}</td>
                    <td className={`py-2 text-end tabular ${advance > 0 ? "font-semibold text-warn" : "text-ink-faint"}`}>
                      {advance > 0 ? diramToSomoniString(advance) : "—"}
                    </td>
                  </tr>
                );
              })}
              {farms.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-ink-faint">
                  {tg.common.nothingFound}
                </td></tr>
              )}
            </tbody>
          </table>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink-soft">{tg.ticket.vehicle}</h2>
            <ul className="divide-y divide-paper-line text-sm">
              {vehicleList.map((v) => (
                <li key={v.id} className="flex justify-between py-1.5">
                  <span>{v.model ?? "—"}</span>
                  <span className="tabular text-ink-soft">{v.plate}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink-soft">{tg.ticket.driver}</h2>
            <ul className="divide-y divide-paper-line text-sm">
              {driverList.map((d) => (
                <li key={d.id} className="py-1.5">{d.fullName}</li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </Shell>
  );
}
