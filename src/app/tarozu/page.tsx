import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  batches,
  counterparties,
  drivers,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { AuthError, requireRole } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { ScaleClient } from "./scale-client";

export const dynamic = "force-dynamic";

export default async function ScalePage() {
  let user;
  try {
    user = await requireRole("weigher");
  } catch (err) {
    if (err instanceof AuthError && err.code === "NOT_SIGNED_IN") redirect("/vorud");
    throw err;
  }

  const season = new Date().getFullYear();

  // Trucks that have been weighed loaded and are still on site — these are what the
  // weigher is waiting for. Ordered oldest first: the one that has been here longest.
  const awaitingTare = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      grossG: weighTickets.grossG,
      createdAt: weighTickets.createdAt,
      farm: counterparties.name,
      plate: vehicles.plate,
      model: vehicles.model,
      driver: drivers.fullName,
      batchNumber: batches.number,
    })
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(drivers, eq(drivers.id, weighTickets.driverId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .where(and(eq(weighTickets.status, "OPEN"), eq(weighTickets.season, season)))
    .orderBy(asc(weighTickets.createdAt));

  const recentlyWeighed = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      netG: weighTickets.netG,
      status: weighTickets.status,
      farm: counterparties.name,
      plate: vehicles.plate,
    })
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .where(
      and(
        inArray(weighTickets.status, ["WEIGHED", "ANALYSED", "PAID"]),
        eq(weighTickets.season, season),
      ),
    )
    .orderBy(desc(weighTickets.weighedAt))
    .limit(8);

  const [farmList, driverList, vehicleList, batchList, varietyList] = await Promise.all([
    db
      .select({ id: counterparties.id, name: counterparties.name, tin: counterparties.tin,
                place: counterparties.defaultLocation, phone: counterparties.phone })
      .from(counterparties)
      .where(and(eq(counterparties.isActive, true), inArray(counterparties.kind, ["farm", "individual"])))
      .orderBy(asc(counterparties.name)),
    db.select({ id: drivers.id, fullName: drivers.fullName })
      .from(drivers).where(eq(drivers.isActive, true)).orderBy(asc(drivers.fullName)),
    db.select({ id: vehicles.id, plate: vehicles.plate, model: vehicles.model })
      .from(vehicles).where(eq(vehicles.isActive, true)).orderBy(asc(vehicles.plate)),
    db
      .select({ id: batches.id, number: batches.number, grade: batches.grade })
      .from(batches)
      .where(and(eq(batches.season, season), isNull(batches.closedAt)))
      .orderBy(asc(batches.number)),
    db.select({ id: varieties.id, code: varieties.code })
      .from(varieties).where(eq(varieties.isActive, true)).orderBy(asc(varieties.code)),
  ]);

  return (
    <Shell user={user} title={`${tg.scale.title} — ${tg.app.season}-${season}`}>
      <ScaleClient
        season={season}
        awaitingTare={awaitingTare.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() }))}
        recentlyWeighed={recentlyWeighed}
        farms={farmList}
        drivers={driverList}
        vehicles={vehicleList}
        batches={batchList}
        varieties={varietyList}
      />
    </Shell>
  );
}
