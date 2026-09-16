import { asc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  batches,
  storageLocations,
  varieties,
  weighTickets,
} from "@/db/schema/index";
import { canOperate, requirePageRole } from "@/lib/auth/session";
import { bpToPercentString, gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { BatchForms } from "./batch-forms";

export const dynamic = "force-dynamic";

export default async function BatchesPage() {
  const user = await requirePageRole("merchandiser", "owner", "accountant", "admin");

  const season = new Date().getFullYear();

  const rows = await db
    .select({
      id: batches.id,
      number: batches.number,
      grade: batches.grade,
      cottonClass: batches.cottonClass,
      closedAt: batches.closedAt,
      variety: varieties.code,
      storage: storageLocations.nameTg,
      tickets: raw<string>`COUNT(DISTINCT ${weighTickets.id})`,
      netG: raw<string>`COALESCE(SUM(${weighTickets.netG}), 0)`,
      // Each truck is analysed on its own, so a партия no longer has a single reading.
      // These aggregate what the lab actually found across the lot: how many loads have
      // been through the lab, and the average weighted by how much cotton each carried.
      analysed: raw<string>`COUNT(DISTINCT ${weighTickets.id})
        FILTER (WHERE ${weighTickets.status} IN ('ANALYSED', 'PAID'))`,
      moistureBp: raw<string>`(
        SELECT ROUND(SUM(la.moisture_bp::numeric * t.net_g) / NULLIF(SUM(t.net_g), 0))
          FROM lab_analyses la
          JOIN weigh_tickets t ON t.id = la.ticket_id
         WHERE t.batch_id = batches.id AND la.stage = 'on_intake'
           AND la.status = 'APPROVED' AND la.superseded_at IS NULL)`,
      trashBp: raw<string>`(
        SELECT ROUND(SUM(la.trash_bp::numeric * t.net_g) / NULLIF(SUM(t.net_g), 0))
          FROM lab_analyses la
          JOIN weigh_tickets t ON t.id = la.ticket_id
         WHERE t.batch_id = batches.id AND la.stage = 'on_intake'
           AND la.status = 'APPROVED' AND la.superseded_at IS NULL)`,
      deductionBp: raw<string>`(
        SELECT ROUND(SUM(COALESCE(la.override_deduction_bp, la.computed_deduction_bp)::numeric
                         * t.net_g) / NULLIF(SUM(t.net_g), 0))
          FROM lab_analyses la
          JOIN weigh_tickets t ON t.id = la.ticket_id
         WHERE t.batch_id = batches.id AND la.stage = 'on_intake'
           AND la.status = 'APPROVED' AND la.superseded_at IS NULL)`,
    })
    .from(batches)
    .leftJoin(varieties, eq(varieties.id, batches.varietyId))
    .leftJoin(storageLocations, eq(storageLocations.id, batches.storageLocationId))
    .leftJoin(weighTickets, eq(weighTickets.batchId, batches.id))
    .where(eq(batches.season, season))
    .groupBy(
      batches.id, batches.number, batches.grade, batches.cottonClass, batches.closedAt,
      varieties.code, storageLocations.nameTg,
    )
    .orderBy(asc(batches.number));

  const [varietyList, storageList] = await Promise.all([
    db.select({ id: varieties.id, code: varieties.code })
      .from(varieties).where(eq(varieties.isActive, true)).orderBy(asc(varieties.code)),
    db.select({ id: storageLocations.id, nameTg: storageLocations.nameTg })
      .from(storageLocations).where(eq(storageLocations.isActive, true))
      .orderBy(asc(storageLocations.code)),
  ]);

  const canManage = canOperate(user, ["merchandiser", "owner", "admin"]);

  return (
    <Shell user={user} title={`${tg.nav.batches} — ${tg.app.season}-${season}`}>
      <div className="space-y-5">
        {canManage && (
          <BatchForms season={season} varieties={varietyList} storages={storageList} />
        )}

        <section className="card overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1 text-start font-medium">{tg.ticket.batch}</th>
                <th className="py-1 text-start font-medium">{tg.ticket.variety}</th>
                <th className="py-1 text-start font-medium">{tg.lab.storage}</th>
                <th className="py-1 text-end font-medium">{tg.ticket.title}</th>
                <th className="py-1 text-end font-medium">{tg.ticket.net}</th>
                <th className="py-1 text-end font-medium">{tg.lab.moisture}</th>
                <th className="py-1 text-end font-medium">{tg.lab.trash}</th>
                <th className="py-1 text-end font-medium">{tg.lab.deduction}</th>
                <th className="py-1 text-start font-medium ps-4">{tg.lab.title}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {rows.map((b) => (
                <tr key={b.id} className={b.closedAt ? "text-ink-faint" : ""}>
                  <td className="py-2 font-semibold">{b.number}</td>
                  <td className="py-2">{b.variety ?? "—"}</td>
                  <td className="py-2">{b.storage ?? "—"}</td>
                  <td className="py-2 text-end tabular">{b.tickets}</td>
                  <td className="py-2 text-end tabular">
                    {gramsToKgString(Number(b.netG), 0)} {tg.common.kg}
                  </td>
                  <td className="py-2 text-end tabular">
                    {b.moistureBp !== null ? bpToPercentString(Number(b.moistureBp)) : "—"}
                  </td>
                  <td className="py-2 text-end tabular">
                    {b.trashBp !== null ? bpToPercentString(Number(b.trashBp)) : "—"}
                  </td>
                  <td className="py-2 text-end tabular font-semibold">
                    {b.deductionBp !== null ? `${bpToPercentString(Number(b.deductionBp))} %` : "—"}
                  </td>
                  <td className="py-2 ps-4">
                    {Number(b.analysed) === Number(b.tickets) && Number(b.tickets) > 0 ? (
                      <span className="badge bg-brand-light text-brand-dark">{tg.lab.approved}</span>
                    ) : (
                      <span className="badge bg-amber-100 text-warn">
                        {b.analysed} / {b.tickets}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="py-8 text-center text-ink-faint">
                  {tg.common.nothingFound}
                </td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </Shell>
  );
}
