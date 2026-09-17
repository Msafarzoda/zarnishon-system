import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  bales,
  batches,
  productionRuns,
  runFeeds,
  runOutputs,
  storageLocations,
  users,
} from "@/db/schema/index";
import { canOperate, requirePageRole } from "@/lib/auth/session";
import { runBatchNumbers, runTotals } from "@/server/services/production";
import { massBalance } from "@/domain/mass-balance";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { ProductionClient } from "./production-client";

export const dynamic = "force-dynamic";

/**
 * Коркард — the gin floor. docs/domain.md §7.
 *
 * The screen is built around the один thing that makes the numbers on it trustworthy: a
 * run with cotton recorded going in. Everything else — outputs, bales, the balance — is
 * arranged under whichever run is open, so an operator cannot record a tonne of чигит
 * against nothing at all without noticing.
 */
export default async function ProductionPage() {
  const user = await requirePageRole(
    "merchandiser", "weigher", "owner", "accountant", "admin",
  );
  const readOnly = !canOperate(user, ["merchandiser", "weigher"]);

  const season = new Date().getFullYear();

  const [open] = await db
    .select({
      id: productionRuns.id,
      serial: productionRuns.serial,
      startedAt: productionRuns.startedAt,
      note: productionRuns.note,
      operator: users.fullName,
    })
    .from(productionRuns)
    .leftJoin(users, eq(users.id, productionRuns.operatorId))
    .where(and(isNull(productionRuns.endedAt), isNull(productionRuns.voidedAt)))
    .orderBy(desc(productionRuns.startedAt))
    .limit(1);

  const openBatches = await db
    .select({
      id: batches.id,
      number: batches.number,
      closedAt: batches.closedAt,
    })
    .from(batches)
    .where(eq(batches.season, season))
    .orderBy(desc(batches.number));

  const stores = await db
    .select({ id: storageLocations.id, name: storageLocations.nameTg })
    .from(storageLocations)
    .where(eq(storageLocations.isActive, true));

  let current = null;
  if (open) {
    const totals = await runTotals(open.id);
    const feeds = await db
      .select({
        id: runFeeds.id,
        weightG: runFeeds.weightG,
        source: runFeeds.source,
        fedAt: runFeeds.fedAt,
        batchNumber: batches.number,
      })
      .from(runFeeds)
      .leftJoin(batches, eq(batches.id, runFeeds.batchId))
      .where(and(eq(runFeeds.runId, open.id), isNull(runFeeds.supersedesId)))
      .orderBy(desc(runFeeds.fedAt))
      .limit(30);

    const outputs = await db
      .select({
        id: runOutputs.id,
        product: runOutputs.product,
        weightG: runOutputs.weightG,
        recordedAt: runOutputs.recordedAt,
      })
      .from(runOutputs)
      .where(and(eq(runOutputs.runId, open.id), isNull(runOutputs.supersedesId)))
      .orderBy(desc(runOutputs.recordedAt))
      .limit(30);

    const pressed = await db
      .select({
        id: bales.id,
        serial: bales.serial,
        weightG: bales.weightG,
        pressedAt: bales.pressedAt,
        batchNumber: batches.number,
      })
      .from(bales)
      .leftJoin(batches, eq(batches.id, bales.batchId))
      .where(and(eq(bales.runId, open.id), isNull(bales.voidedAt)))
      .orderBy(desc(bales.pressedAt))
      .limit(40);

    current = {
      id: open.id,
      serial: open.serial,
      startedAt: open.startedAt.toISOString(),
      operator: open.operator,
      batchNumbers: await runBatchNumbers(open.id),
      totals,
      balance: massBalance(totals),
      feeds: feeds.map((f) => ({ ...f, fedAt: f.fedAt.toISOString() })),
      outputs: outputs.map((o) => ({ ...o, recordedAt: o.recordedAt.toISOString() })),
      bales: pressed.map((b) => ({ ...b, pressedAt: b.pressedAt.toISOString() })),
    };
  }

  // Closed runs, so the floor can look back at yesterday's shift without a report.
  const recentRuns = await db
    .select({
      id: productionRuns.id,
      serial: productionRuns.serial,
      startedAt: productionRuns.startedAt,
      endedAt: productionRuns.endedAt,
      operator: users.fullName,
    })
    .from(productionRuns)
    .leftJoin(users, eq(users.id, productionRuns.operatorId))
    .where(eq(productionRuns.season, season))
    .orderBy(desc(productionRuns.startedAt))
    .limit(10);

  return (
    <Shell user={user} title={tg.production.title}>
      {readOnly && <ReadOnlyBanner />}
      <ProductionClient
        readOnly={readOnly}
        run={current}
        batches={openBatches.map((b) => ({
          id: b.id, number: b.number, closed: b.closedAt !== null,
        }))}
        stores={stores}
        recentRuns={recentRuns.map((r) => ({
          ...r,
          startedAt: r.startedAt.toISOString(),
          endedAt: r.endedAt?.toISOString() ?? null,
        }))}
      />
    </Shell>
  );
}
