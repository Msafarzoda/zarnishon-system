import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  batches,
  counterparties,
  drivers,
  labAnalyses,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { getActiveSettings } from "@/server/services/settings";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { LabClient } from "./lab-client";

export const dynamic = "force-dynamic";

export default async function LabPage() {
  const user = await requirePageRole("lab");

  const season = new Date().getFullYear();
  const settings = await getActiveSettings();

  const columns = {
    ticketId: weighTickets.id,
    serial: weighTickets.serial,
    netG: weighTickets.netG,
    weighedAt: weighTickets.weighedAt,
    status: weighTickets.status,
    farm: counterparties.name,
    plate: vehicles.plate,
    model: vehicles.model,
    driver: drivers.fullName,
    batchNumber: batches.number,
    variety: varieties.code,
    analysisId: labAnalyses.id,
    analysisStatus: labAnalyses.status,
    moistureBp: labAnalyses.moistureBp,
    trashBp: labAnalyses.trashBp,
    computedDeductionBp: labAnalyses.computedDeductionBp,
    overrideDeductionBp: labAnalyses.overrideDeductionBp,
    storageNote: labAnalyses.storageNote,
  };

  const base = () =>
    db
      .select(columns)
      .from(weighTickets)
      .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
      .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
      .leftJoin(drivers, eq(drivers.id, weighTickets.driverId))
      .leftJoin(batches, eq(batches.id, weighTickets.batchId))
      .leftJoin(varieties, eq(varieties.id, weighTickets.varietyId))
      .leftJoin(
        labAnalyses,
        and(
          eq(labAnalyses.ticketId, weighTickets.id),
          eq(labAnalyses.stage, "on_intake"),
          isNull(labAnalyses.supersededAt),
        ),
      );

  // Trucks off the weighbridge and waiting for the lab. Until one is approved its
  // farmer cannot be paid, so the oldest is the most urgent.
  const waiting = await base()
    .where(and(eq(weighTickets.status, "WEIGHED"), eq(weighTickets.season, season)))
    .orderBy(asc(weighTickets.weighedAt));

  const recent = await base()
    .where(and(eq(weighTickets.season, season), eq(labAnalyses.status, "APPROVED")))
    .orderBy(desc(labAnalyses.approvedAt))
    .limit(12);

  return (
    <Shell user={user} title={`${tg.lab.title} — ${tg.lab.formCode}`}>
      <LabClient
        settings={settings}
        waiting={waiting.map((r) => ({
          ...r,
          netG: r.netG ?? 0,
          weighedAt: r.weighedAt?.toISOString() ?? null,
        }))}
        recent={recent.map((r) => ({
          ...r,
          netG: r.netG ?? 0,
          weighedAt: r.weighedAt?.toISOString() ?? null,
        }))}
      />
    </Shell>
  );
}
