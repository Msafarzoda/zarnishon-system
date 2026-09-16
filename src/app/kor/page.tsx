import { and, asc, eq, inArray, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  batches,
  counterparties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { canOperate, requirePageRole } from "@/lib/auth/session";
import { cashOnHandD } from "@/server/services/balances";
import { priceTrend } from "@/server/services/price-trend";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { WorkBoard, type WorkTicket } from "./work-board";

export const dynamic = "force-dynamic";

/**
 * Кори имрӯз — one screen for one person running the whole line.
 *
 * During the parallel season a single operator takes the weights, types in the лаборант's
 * paper form and pays the farm. Split across three station screens, that person has to
 * remember which trucks are waiting at which step and go looking for them. This shows the
 * cotton's whole journey at once — what is on the scale, what the lab has not cleared,
 * what is ready to pay — and every row opens the screen that does the next thing to it.
 *
 * It is deliberately a queue, not a report: the numbers on it are counts of work left.
 * docs/domain.md §6.
 */
export default async function WorkPage() {
  const user = await requirePageRole(
    "weigher", "lab", "cashier", "merchandiser", "owner", "accountant", "admin",
  );

  const season = new Date().getFullYear();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const columns = {
    id: weighTickets.id,
    serial: weighTickets.serial,
    status: weighTickets.status,
    grossG: weighTickets.grossG,
    netG: weighTickets.netG,
    weighedAt: weighTickets.weighedAt,
    createdAt: weighTickets.createdAt,
    farm: counterparties.name,
    tin: counterparties.tin,
    plate: vehicles.plate,
    batchNumber: batches.number,
  };

  const rows = await db
    .select(columns)
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .where(
      and(
        eq(weighTickets.season, season),
        inArray(weighTickets.status, ["OPEN", "WEIGHED", "ANALYSED"]),
      ),
    )
    .orderBy(asc(weighTickets.createdAt));

  const toTicket = (r: (typeof rows)[number]): WorkTicket => ({
    id: r.id,
    serial: r.serial,
    status: r.status,
    grossG: r.grossG,
    netG: r.netG,
    farm: r.farm,
    tin: r.tin,
    plate: r.plate,
    batchNumber: r.batchNumber,
    since: (r.weighedAt ?? r.createdAt).toISOString(),
  });

  const tickets = rows.map(toTicket);

  /*
   * Today's throughput, so a shift can be read at a glance rather than counted.
   *
   * The cut-off is passed as an ISO string cast in SQL, not as a Date: the driver cannot
   * bind a JS Date inside a raw template and throws before the query is ever sent.
   */
  const dayStart = startOfDay.toISOString();

  const [today] = await db
    .select({
      received: raw<string>`COUNT(*) FILTER (
        WHERE ${weighTickets.weighedAt} >= ${dayStart}::timestamptz
          AND ${weighTickets.netG} IS NOT NULL)`,
      receivedG: raw<string>`COALESCE(SUM(${weighTickets.netG}) FILTER (
        WHERE ${weighTickets.weighedAt} >= ${dayStart}::timestamptz), 0)`,
      paid: raw<string>`COUNT(*) FILTER (
        WHERE ${weighTickets.paidAt} >= ${dayStart}::timestamptz)`,
    })
    .from(weighTickets)
    .where(eq(weighTickets.season, season));

  const [analysedToday] = await db
    .select({ n: raw<string>`COUNT(*)` })
    .from(weighTickets)
    .where(
      and(
        eq(weighTickets.season, season),
        raw`EXISTS (
          SELECT 1 FROM lab_analyses la
          WHERE la.ticket_id = weigh_tickets.id
            AND la.status = 'APPROVED'
            AND la.approved_at >= ${dayStart}::timestamptz
        )`,
      ),
    );

  const trend = await priceTrend();

  return (
    <Shell user={user} title={tg.work.title}>
      <WorkBoard
        tickets={tickets}
        cashOnHandD={await cashOnHandD()}
        priceDPerKg={trend.currentD}
        receivedTodayG={Number(today?.receivedG ?? 0)}
        receivedToday={Number(today?.received ?? 0)}
        analysedToday={Number(analysedToday?.n ?? 0)}
        paidToday={Number(today?.paid ?? 0)}
        canWeigh={canOperate(user, ["weigher"])}
        canLab={canOperate(user, ["lab"])}
        canPay={canOperate(user, ["cashier"])}
      />
    </Shell>
  );
}
