import { notFound } from "next/navigation";
import { and, eq, isNull, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  batches,
  counterparties,
  drivers,
  labAnalyses,
  users,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { bpToPercentString, gramsToKgString } from "@/domain/units";
import { payableWeight } from "@/domain/weight";
import { tg } from "@/lib/i18n/tg";
import { PrintButton } from "./print-button";
import {
  PrintCopy,
  PrintField,
  PrintFields,
  PrintIdentity,
  PrintPage,
  PrintSheet,
  PrintSignature,
  PrintSignatures,
  PrintNote,
} from "@/components/print";

export const dynamic = "force-dynamic";

/**
 * Форма №9-хл for one truck.
 *
 * Every load is sampled and its own result decides what that farmer is paid, so the lab
 * keeps a paper certificate per truck — and so does the factory, and the man who
 * delivered it, who is entitled to see the deduction taken off his cotton.
 */
export default async function CertificatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageRole(
    "lab", "merchandiser", "weigher", "cashier", "accountant", "owner", "admin",
  );

  const { id } = await params;

  const [row] = await db
    .select({
      ticketId: weighTickets.id,
      serial: weighTickets.serial,
      season: weighTickets.season,
      netG: weighTickets.netG,
      grade: weighTickets.grade,
      cottonClass: weighTickets.cottonClass,
      weighedAt: weighTickets.weighedAt,
      farm: counterparties.name,
      tin: counterparties.tin,
      plate: vehicles.plate,
      model: vehicles.model,
      driver: drivers.fullName,
      batchNumber: batches.number,
      variety: varieties.code,
      moistureBp: labAnalyses.moistureBp,
      trashBp: labAnalyses.trashBp,
      computedDeductionBp: labAnalyses.computedDeductionBp,
      overrideDeductionBp: labAnalyses.overrideDeductionBp,
      overrideReason: labAnalyses.overrideReason,
      deductionMode: labAnalyses.deductionMode,
      normMoistureBp: labAnalyses.normMoistureBp,
      normTrashBp: labAnalyses.normTrashBp,
      storageNote: labAnalyses.storageNote,
      sampledAt: labAnalyses.sampledAt,
      approvedAt: labAnalyses.approvedAt,
      labUser: users.fullName,
    })
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .innerJoin(
      labAnalyses,
      and(
        eq(labAnalyses.ticketId, weighTickets.id),
        eq(labAnalyses.stage, "on_intake"),
        eq(labAnalyses.status, "APPROVED"),
        isNull(labAnalyses.supersededAt),
      ),
    )
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(drivers, eq(drivers.id, weighTickets.driverId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .leftJoin(varieties, eq(varieties.id, weighTickets.varietyId))
    .leftJoin(users, eq(users.id, labAnalyses.approvedBy))
    .where(eq(weighTickets.id, id))
    .limit(1);

  if (!row) notFound();

  const [printed] = await db
    .select({ n: raw<string>`COUNT(*)` })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, row.ticketId), eq(auditLog.action, "lab.print")));
  const printCount = Number(printed?.n ?? 0);

  const deductionBp = row.overrideDeductionBp ?? row.computedDeductionBp;
  const netG = row.netG ?? 0;
  const payableG = payableWeight(netG, deductionBp);

  const copies = [tg.lab.copyLab, tg.lab.copyFactory, tg.lab.copyDriver];

  return (
    <PrintPage>
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] items-center gap-3 px-4">
        <a href="/laboratoriya" className="btn-secondary">{tg.common.back}</a>
        <span className="font-mono text-brand">{row.serial}</span>
        {printCount > 0 && (
          <span className="badge bg-amber-100 text-warn">
            {tg.ticket.printedTimes}: {printCount}
          </span>
        )}
        <PrintButton ticketId={row.ticketId} alreadyPrinted={printCount} />
      </div>
      <p className="no-print mx-auto mb-3 max-w-[210mm] px-4 text-sm text-ink-soft">
        {tg.ticket.printHint}
      </p>

      <PrintSheet>
        {copies.map((label, i) => (
          <PrintCopy
            key={label}
            formCode={tg.lab.formCode}
            title={tg.lab.certificate2}
            copyLabel={label}
            cutAbove={i > 0}
            right={
              <PrintIdentity
                season={row.season}
                batchNumber={row.batchNumber}
                serial={row.serial}
              />
            }
          >
            <PrintFields>
              <PrintField label={tg.ticket.date}
                          value={(row.approvedAt ?? row.sampledAt)?.toLocaleDateString("ru-RU")} />
              <PrintField label={tg.ticket.number} value={row.serial} />
              <PrintField label={tg.ticket.consignor} value={row.farm} />
              <PrintField label={tg.ticket.tin} value={row.tin} />
              <PrintField label={tg.ticket.vehicle}
                          value={[row.model, row.plate].filter(Boolean).join(" · ")} />
              <PrintField label={tg.ticket.driver} value={row.driver} />
              <PrintField label={tg.lab.variety} value={row.variety} />
              <PrintField label={tg.lab.storage} value={row.storageNote} />
            </PrintFields>

            <table className="mt-2 w-full border-collapse text-center">
              <thead>
                <tr className="bg-paper text-[10px] text-ink-soft">
                  <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.ticket.net}</th>
                  <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.lab.moisture}</th>
                  <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.lab.trash}</th>
                  <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.lab.deduction}</th>
                  <th className="border-2 border-ink px-2 py-0.5 font-semibold text-ink">{tg.cash.payable}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="tabular">
                  <td className="border border-ink-faint px-2 py-1">{gramsToKgString(netG, 1)}</td>
                  <td className="border border-ink-faint px-2 py-1">
                    {bpToPercentString(row.moistureBp)}
                  </td>
                  <td className="border border-ink-faint px-2 py-1">
                    {bpToPercentString(row.trashBp)}
                  </td>
                  <td className="border border-ink-faint px-2 py-1 font-semibold">
                    {bpToPercentString(deductionBp)}
                  </td>
                  <td className="print-net border-2 border-ink px-2 py-1 text-sm font-bold">
                    {gramsToKgString(payableG, 1)}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="flex justify-between text-[9px] text-ink-faint">
              {/* The rule the deduction was calculated under, frozen at approval. */}
              <span>
                {row.deductionMode === "TOTAL"
                  ? `${tg.lab.moisture} + ${tg.lab.trash}`
                  : `> ${bpToPercentString(row.normMoistureBp, 0)}% · > ${bpToPercentString(row.normTrashBp, 0)}%`}
              </span>
              <span>{tg.ticket.weightSection}</span>
            </div>

            {row.overrideDeductionBp !== null && (
              <PrintNote>
                {tg.lab.override}: {bpToPercentString(row.computedDeductionBp)} % →{" "}
                {bpToPercentString(row.overrideDeductionBp)} % — {row.overrideReason}
              </PrintNote>
            )}

            <PrintSignatures>
              <PrintSignature label={tg.lab.labHead2} name={row.labUser} />
              <PrintSignature label={tg.lab.sampledBy} />
              <PrintSignature label={tg.lab.acknowledged} name={row.driver} />
            </PrintSignatures>
          </PrintCopy>
        ))}
      </PrintSheet>
    </PrintPage>
  );
}

function Signature({ label, name }: { label: string; name: string | null }) {
  return (
    <div>
      <div className="h-5 border-b border-ink-faint" />
      <div className="mt-0.5 text-ink-faint">{label}</div>
      <div className="font-medium">{name ?? " "}</div>
    </div>
  );
}
