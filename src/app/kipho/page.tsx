import { and, desc, eq, isNull, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { bales, batches, storageLocations } from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { gramsToKgString } from "@/domain/units";
import { divRound } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { tgBaleState, tgProduct } from "@/lib/i18n/products";
import { Shell } from "@/components/shell";
import { Empty, Section, Stat } from "@/components/ui";
import { BaleTable } from "./bale-table";

export const dynamic = "force-dynamic";

/**
 * Кипҳо — the bale warehouse.
 *
 * Bales are the factory's largest asset for most of the year and the only stock it holds
 * as countable objects, so this screen answers the two questions anybody actually asks:
 * how many are standing in the shed, and where did this one in my hand come from.
 * Everything is grouped by партия because that is how the sheds are stacked.
 */
export default async function BalesPage() {
  const user = await requirePageRole(
    "merchandiser", "weigher", "cashier", "owner", "accountant", "admin",
  );

  const rows = await db
    .select({
      id: bales.id,
      serial: bales.serial,
      weightG: bales.weightG,
      grade: bales.grade,
      state: bales.state,
      pressedAt: bales.pressedAt,
      batchNumber: batches.number,
      store: storageLocations.nameTg,
    })
    .from(bales)
    .leftJoin(batches, eq(batches.id, bales.batchId))
    .leftJoin(storageLocations, eq(storageLocations.id, bales.storageLocationId))
    .where(isNull(bales.voidedAt))
    .orderBy(desc(bales.pressedAt))
    .limit(1000);

  const [stock] = await db
    .select({
      count: raw<string>`COUNT(*)`,
      weightG: raw<string>`COALESCE(SUM(${bales.weightG}), 0)`,
    })
    .from(bales)
    .where(and(eq(bales.state, "IN_STOCK"), isNull(bales.voidedAt)));

  const byBatch = await db
    .select({
      batchNumber: batches.number,
      count: raw<string>`COUNT(*)`,
      weightG: raw<string>`COALESCE(SUM(${bales.weightG}), 0)`,
    })
    .from(bales)
    .innerJoin(batches, eq(batches.id, bales.batchId))
    .where(and(eq(bales.state, "IN_STOCK"), isNull(bales.voidedAt)))
    .groupBy(batches.number)
    .orderBy(desc(batches.number));

  const count = Number(stock?.count ?? 0);
  const weightG = Number(stock?.weightG ?? 0);

  return (
    <Shell user={user} title={tg.bales.title}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat
            accent
            size="lg"
            label={`${tgProduct.kip} — ${tg.bales.inStock}`}
            value={String(count)}
            hint={tg.bales.subtitle}
          />
          <Stat
            label={tg.bales.totalWeight}
            value={gramsToKgString(weightG, 0)}
            unit={tg.common.kg}
          />
          <Stat
            label={tg.bales.average}
            value={count > 0 ? gramsToKgString(divRound(weightG, count), 1) : "—"}
            unit={tg.common.kg}
            /* A drifting average is the first sign of light bales, and it shows here
               before the run's mass balance has enough runs to be sure. */
            hint={tg.production.yield}
          />
        </div>

        {byBatch.length > 0 && (
          <Section title={`${tg.bales.inStock} — ${tg.ticket.batch}`}>
            <ul className="flex flex-wrap gap-2">
              {byBatch.map((b) => (
                <li key={b.batchNumber} className="card px-3 py-2">
                  <div className="text-xs text-ink-soft">{tg.ticket.batch} {b.batchNumber}</div>
                  <div className="tabular text-lg font-bold">{Number(b.count)}</div>
                  <div className="tabular text-xs text-ink-faint">
                    {gramsToKgString(Number(b.weightG), 0)} {tg.common.kg}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {rows.length === 0 ? (
          <Empty title={tg.common.nothingFound} hint={tg.production.noOpenRunHint} />
        ) : (
          <BaleTable
            bales={rows.map((b) => ({
              ...b,
              pressedAt: b.pressedAt.toISOString(),
              stateLabel: tgBaleState[b.state] ?? b.state,
            }))}
          />
        )}
      </div>
    </Shell>
  );
}
