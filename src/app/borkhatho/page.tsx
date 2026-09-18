import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { batches, counterparties, drivers, vehicles, weighTickets } from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { TicketsClient } from "./tickets-client";

export const dynamic = "force-dynamic";

/**
 * Борхатҳо — every Борхат this season, one place, searchable.
 *
 * Each other screen shows only the tickets it has work to do on — тарозу shows what is
 * still on the scale, лаборатория what is waiting for a sample, хазина what is ready to
 * pay. None of them answers "find me борхат №73" or "what did this farm bring in three
 * weeks ago" once a ticket has moved past the screen that made it. This is that list —
 * read-only, every status, newest first.
 */
export default async function TicketsPage() {
  const user = await requirePageRole(
    "weigher", "merchandiser", "cashier", "accountant", "owner", "admin",
  );

  const season = new Date().getFullYear();

  const rows = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      status: weighTickets.status,
      farm: counterparties.name,
      tin: counterparties.tin,
      plate: vehicles.plate,
      driver: drivers.fullName,
      batchNumber: batches.number,
      grossG: weighTickets.grossG,
      tareG: weighTickets.tareG,
      netG: weighTickets.netG,
      createdAt: weighTickets.createdAt,
      weighedAt: weighTickets.weighedAt,
      paidAt: weighTickets.paidAt,
    })
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(drivers, eq(drivers.id, weighTickets.driverId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .where(eq(weighTickets.season, season))
    .orderBy(desc(weighTickets.createdAt))
    .limit(1000);

  return (
    <Shell user={user} title={tg.nav.tickets}>
      <TicketsClient
        tickets={rows.map((t) => ({
          ...t,
          createdAt: t.createdAt.toISOString(),
          weighedAt: t.weighedAt?.toISOString() ?? null,
          paidAt: t.paidAt?.toISOString() ?? null,
        }))}
      />
    </Shell>
  );
}
