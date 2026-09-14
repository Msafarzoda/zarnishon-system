import { asc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { counterparties, drivers, vehicles } from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { divRound } from "@/domain/units";
import { priceTrend } from "@/server/services/price-trend";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { FarmsClient } from "./farms-client";

export const dynamic = "force-dynamic";

/**
 * Хоҷагиҳо — the customer list.
 *
 * Used to find one farm among many and to see, without opening anything, who is owed
 * cotton money and who owes us an advance. Everything here is derived from the ledger and
 * the tickets; nothing is a stored total.
 *
 * Tables are named explicitly inside the subqueries: interpolating a Drizzle column into
 * a raw template renders it unqualified, which collides with the joined tables.
 */
export default async function FarmsPage() {
  const user = await requirePageRole(
    "merchandiser", "cashier", "owner", "accountant", "admin",
  );

  const trend = await priceTrend();

  const farms = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      tin: counterparties.tin,
      place: counterparties.defaultLocation,
      phone: counterparties.phone,
      deliveredG: raw<string>`COALESCE((
        SELECT SUM(t.net_g) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status <> 'VOID'
      ), 0)`,
      paidD: raw<string>`COALESCE((
        SELECT SUM(p.cash_payable_d) FROM payments p
        WHERE p.counterparty_id = counterparties.id AND p.reversed_at IS NULL
      ), 0)`,
      unpaidTickets: raw<string>`COALESCE((
        SELECT COUNT(*) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status = 'ANALYSED'
      ), 0)`,
      // Weight the lab has cleared that has not been paid for — what we actually owe.
      unpaidPayableG: raw<string>`COALESCE((
        SELECT SUM(ROUND(t.net_g::numeric * (10000 - COALESCE(
          (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
             FROM lab_analyses la
            WHERE la.ticket_id = t.id AND la.stage = 'on_intake'
              AND la.status = 'APPROVED' AND la.superseded_at IS NULL LIMIT 1),
          (SELECT COALESCE(la.override_deduction_bp, la.computed_deduction_bp)
             FROM lab_analyses la
            WHERE la.batch_id = t.batch_id AND la.stage = 'on_intake'
              AND la.status = 'APPROVED' AND la.superseded_at IS NULL LIMIT 1),
          0)) / 10000))
        FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id AND t.status = 'ANALYSED'
      ), 0)`,
      advanceD: raw<string>`COALESCE((
        SELECT SUM(e.amount_d) FROM ledger_entries e
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'ADVANCE_RECEIVABLE' AND a.counterparty_id = counterparties.id
      ), 0)`,
    })
    .from(counterparties)
    .where(eq(counterparties.isActive, true))
    .orderBy(asc(counterparties.name));

  const [vehicleList, driverList] = await Promise.all([
    db.select({ id: vehicles.id, plate: vehicles.plate, model: vehicles.model,
                transportOrg: vehicles.transportOrg })
      .from(vehicles).where(eq(vehicles.isActive, true)).orderBy(asc(vehicles.plate)).limit(200),
    db.select({ id: drivers.id, fullName: drivers.fullName, phone: drivers.phone })
      .from(drivers).where(eq(drivers.isActive, true)).orderBy(asc(drivers.fullName)).limit(200),
  ]);

  const rows = farms.map((f) => {
    const unpaidPayableG = Number(f.unpaidPayableG);
    return {
      id: f.id,
      name: f.name,
      tin: f.tin,
      place: f.place,
      phone: f.phone,
      deliveredG: Number(f.deliveredG),
      paidD: Number(f.paidD),
      unpaidTickets: Number(f.unpaidTickets),
      unpaidPayableG,
      unpaidValueD:
        trend.currentD !== null ? divRound(unpaidPayableG * trend.currentD, 1000) : null,
      advanceD: Math.max(0, Number(f.advanceD)),
    };
  });

  return (
    <Shell user={user} title={tg.nav.farms}>
      <FarmsClient farms={rows} vehicles={vehicleList} drivers={driverList} />
    </Shell>
  );
}
