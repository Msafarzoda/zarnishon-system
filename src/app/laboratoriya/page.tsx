import { redirect } from "next/navigation";
import { and, asc, eq, isNull, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { batches, labAnalyses, varieties, weighTickets } from "@/db/schema/index";
import { AuthError, requireRole } from "@/lib/auth/session";
import { getActiveSettings } from "@/server/services/settings";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { LabClient } from "./lab-client";

export const dynamic = "force-dynamic";

export default async function LabPage() {
  let user;
  try {
    user = await requireRole("lab");
  } catch (err) {
    if (err instanceof AuthError && err.code === "NOT_SIGNED_IN") redirect("/vorud");
    throw err;
  }

  const season = new Date().getFullYear();
  const settings = await getActiveSettings();

  // Every open партия, with how much cotton is sitting in it and whether the intake
  // analysis has been done. A партия with cotton and no approved analysis is what
  // holds up payment, so those sort to the top.
  const rows = await db
    .select({
      batchId: batches.id,
      number: batches.number,
      grade: batches.grade,
      variety: varieties.code,
      ticketCount: raw<string>`COUNT(DISTINCT ${weighTickets.id})`,
      netG: raw<string>`COALESCE(SUM(${weighTickets.netG}), 0)`,
      analysisId: labAnalyses.id,
      analysisStatus: labAnalyses.status,
      moistureBp: labAnalyses.moistureBp,
      trashBp: labAnalyses.trashBp,
      computedDeductionBp: labAnalyses.computedDeductionBp,
      overrideDeductionBp: labAnalyses.overrideDeductionBp,
      storageNote: labAnalyses.storageNote,
    })
    .from(batches)
    .leftJoin(varieties, eq(varieties.id, batches.varietyId))
    .leftJoin(weighTickets, eq(weighTickets.batchId, batches.id))
    .leftJoin(
      labAnalyses,
      and(
        eq(labAnalyses.batchId, batches.id),
        eq(labAnalyses.stage, "on_intake"),
        isNull(labAnalyses.supersededAt),
      ),
    )
    .where(eq(batches.season, season))
    .groupBy(
      batches.id, batches.number, batches.grade, varieties.code,
      labAnalyses.id, labAnalyses.status, labAnalyses.moistureBp, labAnalyses.trashBp,
      labAnalyses.computedDeductionBp, labAnalyses.overrideDeductionBp, labAnalyses.storageNote,
    )
    .orderBy(asc(batches.number));

  return (
    <Shell user={user} title={`${tg.lab.title} — ${tg.lab.formCode}`}>
      <LabClient
        season={season}
        settings={settings}
        batches={rows.map((r) => ({
          ...r,
          ticketCount: Number(r.ticketCount),
          netG: Number(r.netG),
        }))}
      />
    </Shell>
  );
}
