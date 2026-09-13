import { redirect } from "next/navigation";
import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { batches, counterparties, drivers, vehicles, weighTickets } from "@/db/schema/index";
import { AuthError, requireRole } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { GateClient } from "./gate-client";

export const dynamic = "force-dynamic";

export default async function GatePage() {
  let user;
  try {
    user = await requireRole("guard", "weigher");
  } catch (err) {
    if (err instanceof AuthError && err.code === "NOT_SIGNED_IN") redirect("/vorud");
    throw err;
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const select = {
    id: weighTickets.id,
    serial: weighTickets.serial,
    gate: weighTickets.gate,
    grossG: weighTickets.grossG,
    tareG: weighTickets.tareG,
    createdAt: weighTickets.createdAt,
    farm: counterparties.name,
    plate: vehicles.plate,
    model: vehicles.model,
    driver: drivers.fullName,
    batchNumber: batches.number,
  };

  // Everything still inside the fence, whatever stage it is at.
  const onSite = await db
    .select(select)
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(drivers, eq(drivers.id, weighTickets.driverId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .where(
      and(
        ne(weighTickets.gate, "DEPARTED"),
        inArray(weighTickets.status, ["DRAFT", "OPEN", "WEIGHED", "ANALYSED"]),
      ),
    )
    .orderBy(asc(weighTickets.createdAt));

  const departedToday = await db
    .select(select)
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(drivers, eq(drivers.id, weighTickets.driverId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .where(and(eq(weighTickets.gate, "DEPARTED"), gte(weighTickets.departedAt, startOfDay)))
    .orderBy(asc(weighTickets.departedAt));

  return (
    <Shell user={user} title={tg.gate.title}>
      <GateClient
        onSite={onSite.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() }))}
        departedTodayCount={departedToday.length}
      />
    </Shell>
  );
}
