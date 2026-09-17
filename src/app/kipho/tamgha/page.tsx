import { inArray } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bales, batches } from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { BaleLabel } from "@/components/bale-label";
import { PrintPage } from "@/components/print";
import { tg } from "@/lib/i18n/tg";
import { LabelPrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * A sheet of bale labels, ready to cut.
 *
 * Reprinting a bale label is not the same risk as reprinting a Борхат: the Борхат is
 * exchanged for cash, while a duplicate bale label points at a bale that either exists or
 * does not — scanning it twice onto the same lorry is refused, and scanning it onto a
 * second lorry is refused by the sale. So this is not logged as a reprint; labels fall off
 * bales and get wet, and making a replacement awkward would only produce hand-written ones.
 */
export default async function BaleLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  await requirePageRole("merchandiser", "weigher", "owner", "accountant", "admin");

  const { ids } = await searchParams;
  const list = (ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const rows = list.length
    ? await db
        .select({
          id: bales.id,
          serial: bales.serial,
          weightG: bales.weightG,
          grade: bales.grade,
          pressedAt: bales.pressedAt,
          batchNumber: batches.number,
        })
        .from(bales)
        .leftJoin(batches, eq(batches.id, bales.batchId))
        .where(inArray(bales.id, list))
        .limit(500)
    : [];

  return (
    <PrintPage>
      <div className="mx-auto max-w-[210mm] px-4">
        <div className="no-print mb-4 flex items-center justify-between">
          <h1 className="page-title">
            {tg.bales.label} — {rows.length}
          </h1>
          <LabelPrintButton />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {rows.map((b) => (
            <BaleLabel
              key={b.id}
              serial={b.serial}
              weightG={b.weightG}
              batchNumber={b.batchNumber}
              grade={b.grade}
              pressedAt={b.pressedAt.toISOString()}
            />
          ))}
        </div>
      </div>
    </PrintPage>
  );
}
