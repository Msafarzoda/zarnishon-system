import { and, eq, isNull, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  bales,
  batches,
  productionRuns,
  runFeeds,
  runOutputs,
} from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { baleSerial, type ProductKind } from "@/domain/product";
import { massBalance, type MassBalance, type RunTotals } from "@/domain/mass-balance";
import { getActiveSettings } from "./settings";

/**
 * Коркард — the ginning half of the factory. docs/domain.md §7.
 *
 * Everything here exists to make one equation checkable:
 *
 *     пахтаи фиристодашуда = чигит + кип + улюк + пучоқ + талафот
 *
 * So the order of operations matters more than it looks. The cotton fed in is recorded
 * first; outputs are recorded against that run; and a bale is pressed into the run, so its
 * weight lands on the right-hand side of the same equation. Record the bales and not the
 * feed and there is nothing to check them against — which is how a factory loses a tonne
 * of lint without a single number looking wrong.
 */

type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

// ---------------------------------------------------------------- runs

export interface OpenRunInput {
  clientUuid: string;
  operatorId: string;
  stationId?: string | null;
  note?: string | null;
  startedAt?: Date;
}

export async function openRun(input: OpenRunInput) {
  const startedAt = input.startedAt ?? new Date();
  const season = startedAt.getFullYear();

  const [existing] = await db
    .select()
    .from(productionRuns)
    .where(eq(productionRuns.clientUuid, input.clientUuid))
    .limit(1);
  if (existing) return { id: existing.id, serial: existing.serial, replayed: true };

  return await db.transaction(async (tx) => {
    const serial = await nextRunSerial(tx, season);
    const [row] = await tx
      .insert(productionRuns)
      .values({
        clientUuid: input.clientUuid,
        season,
        serial,
        startedAt,
        operatorId: input.operatorId,
        stationId: input.stationId ?? null,
        note: input.note?.trim() || null,
      })
      .returning();
    if (!row) throw new Error("Could not open the production run.");

    await tx.insert(auditLog).values({
      action: "production.run.open",
      entityTable: "production_runs",
      entityId: row.id,
      payload: { serial },
      actorId: input.operatorId,
      stationId: input.stationId ?? null,
      occurredAt: startedAt,
    });

    return { id: row.id, serial, replayed: false };
  });
}

async function nextRunSerial(x: Executor, season: number): Promise<string> {
  await x.execute(raw`SELECT pg_advisory_xact_lock(hashtext('zarnishon:run_serial'))`);
  const [row] = await x
    .select({ n: raw<string>`COUNT(*)` })
    .from(productionRuns)
    .where(eq(productionRuns.season, season));
  return `R-${season}-${String(Number(row?.n ?? 0) + 1).padStart(6, "0")}`;
}

export async function closeRun(runId: string, operatorId: string) {
  const [row] = await db
    .select()
    .from(productionRuns)
    .where(eq(productionRuns.id, runId))
    .limit(1);
  if (!row) throw new DomainError("Баст ёфт нашуд. / No such production run.");
  if (row.endedAt) return { id: row.id, serial: row.serial, alreadyClosed: true };

  await db
    .update(productionRuns)
    .set({ endedAt: new Date() })
    .where(eq(productionRuns.id, runId));

  await db.insert(auditLog).values({
    action: "production.run.close",
    entityTable: "production_runs",
    entityId: runId,
    payload: { serial: row.serial, balance: await runMassBalance(runId) },
    actorId: operatorId,
    occurredAt: new Date(),
  });

  return { id: row.id, serial: row.serial, alreadyClosed: false };
}

/** A run must be open to take feed, outputs or bales — closed is closed. */
async function requireOpenRun(x: Executor, runId: string) {
  const [run] = await x
    .select()
    .from(productionRuns)
    .where(eq(productionRuns.id, runId))
    .limit(1);
  if (!run) throw new DomainError("Баст ёфт нашуд. / No such production run.");
  if (run.voidedAt) throw new DomainError("Ин баст бекор карда шудааст. / This run was voided.");
  if (run.endedAt) {
    throw new DomainError(
      "Ин баст пӯшида шудааст — барои сабти нав басти нав кушоед. / " +
        "This run is closed; open a new one to record anything further.",
    );
  }
  return run;
}

// ---------------------------------------------------------------- feed

export interface RecordFeedInput {
  clientUuid: string;
  runId: string;
  weightG: number;
  batchId?: string | null;
  storageLocationId?: string | null;
  varietyId?: string | null;
  /** `recycled` for улюк coming back through. Never counts towards yield. */
  source?: "primary" | "recycled";
  weighSource?: "manual" | "indicator";
  indicatorRaw?: string | null;
  reason?: string | null;
  operatorId: string;
  fedAt?: Date;
}

export async function recordFeed(input: RecordFeedInput) {
  if (!Number.isSafeInteger(input.weightG) || input.weightG <= 0) {
    throw new DomainError("Вазн бояд аз сифр зиёд бошад. / The weight must be above zero.");
  }
  // A hand-typed weight has to say why there was no indicator behind it. Same rule as the
  // weighbridge in §2 — the reason is the only thing standing behind a manual number.
  if ((input.weighSource ?? "manual") === "manual" && !input.reason?.trim()) {
    throw new DomainError(
      "Вазни дастӣ бе сабаб қабул намешавад. / A hand-entered weight needs a reason.",
    );
  }

  const [existing] = await db
    .select()
    .from(runFeeds)
    .where(eq(runFeeds.clientUuid, input.clientUuid))
    .limit(1);
  if (existing) return { id: existing.id, replayed: true };

  return await db.transaction(async (tx) => {
    await requireOpenRun(tx, input.runId);
    const [row] = await tx
      .insert(runFeeds)
      .values({
        clientUuid: input.clientUuid,
        runId: input.runId,
        batchId: input.batchId ?? null,
        storageLocationId: input.storageLocationId ?? null,
        varietyId: input.varietyId ?? null,
        source: input.source ?? "primary",
        weightG: input.weightG,
        weighSource: input.weighSource ?? "manual",
        indicatorRaw: input.indicatorRaw ?? null,
        reason: input.reason?.trim() || null,
        fedAt: input.fedAt ?? new Date(),
        operatorId: input.operatorId,
      })
      .returning({ id: runFeeds.id });
    if (!row) throw new Error("Could not record the feed.");
    return { id: row.id, replayed: false };
  });
}

// ---------------------------------------------------------------- bulk outputs

export interface RecordOutputInput {
  clientUuid: string;
  runId: string;
  product: ProductKind;
  weightG: number;
  storageLocationId?: string | null;
  weighSource?: "manual" | "indicator";
  indicatorRaw?: string | null;
  reason?: string | null;
  operatorId: string;
  recordedAt?: Date;
}

export async function recordOutput(input: RecordOutputInput) {
  if (input.product === "kip") {
    /*
     * Кип is not a heap. Recording it as bulk would put a second, disagreeing figure for
     * lint into the mass balance alongside the sum of the bales — and the balance would
     * then be checking the factory against itself rather than against the cotton.
     */
    throw new DomainError(
      "Кип ҳамчун маҳсулоти фалокӣ сабт намешавад — ҳар кип алоҳида сабт мешавад. / " +
        "Bales are recorded one by one at the press, never as a bulk output.",
    );
  }
  if (!Number.isSafeInteger(input.weightG) || input.weightG <= 0) {
    throw new DomainError("Вазн бояд аз сифр зиёд бошад. / The weight must be above zero.");
  }
  if ((input.weighSource ?? "manual") === "manual" && !input.reason?.trim()) {
    throw new DomainError(
      "Вазни дастӣ бе сабаб қабул намешавад. / A hand-entered weight needs a reason.",
    );
  }

  const [existing] = await db
    .select()
    .from(runOutputs)
    .where(eq(runOutputs.clientUuid, input.clientUuid))
    .limit(1);
  if (existing) return { id: existing.id, replayed: true };

  return await db.transaction(async (tx) => {
    await requireOpenRun(tx, input.runId);
    const [row] = await tx
      .insert(runOutputs)
      .values({
        clientUuid: input.clientUuid,
        runId: input.runId,
        product: input.product,
        weightG: input.weightG,
        storageLocationId: input.storageLocationId ?? null,
        weighSource: input.weighSource ?? "manual",
        indicatorRaw: input.indicatorRaw ?? null,
        reason: input.reason?.trim() || null,
        recordedAt: input.recordedAt ?? new Date(),
        operatorId: input.operatorId,
      })
      .returning({ id: runOutputs.id });
    if (!row) throw new Error("Could not record the output.");
    return { id: row.id, replayed: false };
  });
}

// ---------------------------------------------------------------- bales

export interface PressBaleInput {
  clientUuid: string;
  runId: string;
  /** Which партия this bale's lint came from. Required — it is half the serial. */
  batchId: string;
  weightG: number;
  grade?: string | null;
  storageLocationId?: string | null;
  operatorId: string;
  stationId?: string | null;
  pressedAt?: Date;
}

/**
 * A bale comes off the press, is weighed on the mechanical scale and is given its number.
 *
 * The weight is typed, which §2 otherwise forbids, because the bale scale is mechanical
 * and there is nothing to read it from. Per bale that number cannot be checked at all;
 * what catches a systematic understatement is the run's mass balance in aggregate, which
 * is why bales must be pressed **into a run** and why a run with no feed recorded alarms.
 */
export async function pressBale(input: PressBaleInput) {
  if (!Number.isSafeInteger(input.weightG) || input.weightG <= 0) {
    throw new DomainError("Вазни кип бояд аз сифр зиёд бошад. / A bale must weigh something.");
  }

  const [existing] = await db
    .select()
    .from(bales)
    .where(eq(bales.clientUuid, input.clientUuid))
    .limit(1);
  if (existing) {
    return {
      id: existing.id, serial: existing.serial, weightG: existing.weightG, replayed: true,
    };
  }

  const pressedAt = input.pressedAt ?? new Date();

  return await db.transaction(async (tx) => {
    await requireOpenRun(tx, input.runId);

    const [batch] = await tx
      .select({ id: batches.id, number: batches.number, season: batches.season })
      .from(batches)
      .where(eq(batches.id, input.batchId))
      .limit(1);
    if (!batch) throw new DomainError("Партия ёфт нашуд. / No such партия.");

    /*
     * Numbered within its партия, under a lock held to the end of the transaction. Two
     * presses running at once would otherwise compute the same number; the unique index
     * would reject one of them, and a bale that physically exists would have no record.
     */
    await tx.execute(
      raw`SELECT pg_advisory_xact_lock(hashtext('zarnishon:bale_serial'), ${batch.number})`,
    );
    const [counted] = await tx
      .select({ n: raw<string>`COUNT(*)` })
      .from(bales)
      .where(eq(bales.batchId, batch.id));
    const n = Number(counted?.n ?? 0) + 1;
    const serial = baleSerial(batch.season, batch.number, n);

    const [row] = await tx
      .insert(bales)
      .values({
        clientUuid: input.clientUuid,
        serial,
        season: batch.season,
        serialNumber: n,
        runId: input.runId,
        batchId: batch.id,
        weightG: input.weightG,
        grade: input.grade?.trim() || null,
        storageLocationId: input.storageLocationId ?? null,
        pressedAt,
        operatorId: input.operatorId,
        stationId: input.stationId ?? null,
      })
      .returning({ id: bales.id });
    if (!row) throw new Error("Could not record the bale.");

    await tx.insert(auditLog).values({
      action: "production.bale.press",
      entityTable: "bales",
      entityId: row.id,
      payload: { serial, weightG: input.weightG, batch: batch.number, runId: input.runId },
      actorId: input.operatorId,
      stationId: input.stationId ?? null,
      occurredAt: pressedAt,
    });

    return { id: row.id, serial, weightG: input.weightG, replayed: false };
  });
}

// ---------------------------------------------------------------- the balance

/** What went in and what came out of one run, in grams. */
export async function runTotals(runId: string, x: Pick<typeof db, "select"> = db): Promise<RunTotals> {
  const [feed] = await x
    .select({
      primaryG: raw<string>`COALESCE(SUM(${runFeeds.weightG}) FILTER (WHERE ${runFeeds.source} = 'primary'), 0)`,
      recycledG: raw<string>`COALESCE(SUM(${runFeeds.weightG}) FILTER (WHERE ${runFeeds.source} = 'recycled'), 0)`,
    })
    .from(runFeeds)
    .where(and(eq(runFeeds.runId, runId), isNull(runFeeds.supersedesId)));

  const [out] = await x
    .select({
      chigitG: raw<string>`COALESCE(SUM(${runOutputs.weightG}) FILTER (WHERE ${runOutputs.product} = 'chigit'), 0)`,
      ulyukG: raw<string>`COALESCE(SUM(${runOutputs.weightG}) FILTER (WHERE ${runOutputs.product} = 'ulyuk'), 0)`,
      puchoqG: raw<string>`COALESCE(SUM(${runOutputs.weightG}) FILTER (WHERE ${runOutputs.product} = 'puchoq'), 0)`,
    })
    .from(runOutputs)
    .where(and(eq(runOutputs.runId, runId), isNull(runOutputs.supersedesId)));

  // Lint is the sum of the bales, not a bulk figure. A voided bale is gone from both.
  const [kip] = await x
    .select({ kipG: raw<string>`COALESCE(SUM(${bales.weightG}), 0)` })
    .from(bales)
    .where(and(eq(bales.runId, runId), isNull(bales.voidedAt)));

  return {
    feedG: Number(feed?.primaryG ?? 0),
    recycledG: Number(feed?.recycledG ?? 0),
    chigitG: Number(out?.chigitG ?? 0),
    kipG: Number(kip?.kipG ?? 0),
    ulyukG: Number(out?.ulyukG ?? 0),
    puchoqG: Number(out?.puchoqG ?? 0),
  };
}

export async function runMassBalance(runId: string): Promise<MassBalance> {
  await getActiveSettings(); // fails loudly if the factory was never configured
  const [run] = await db
    .select({ endedAt: productionRuns.endedAt })
    .from(productionRuns)
    .where(eq(productionRuns.id, runId))
    .limit(1);
  // An open run's proportions are half a shift out of date by construction — see
  // `RunStage` in src/domain/mass-balance.ts.
  return massBalance(
    await runTotals(runId),
    undefined,
    run?.endedAt ? "closed" : "open",
  );
}

/** Кипи дар анбор — how many bales the factory is holding, and what they weigh. */
export async function baleStock(): Promise<{ count: number; weightG: number }> {
  const [row] = await db
    .select({
      count: raw<string>`COUNT(*)`,
      weightG: raw<string>`COALESCE(SUM(${bales.weightG}), 0)`,
    })
    .from(bales)
    .where(eq(bales.state, "IN_STOCK"));
  return { count: Number(row?.count ?? 0), weightG: Number(row?.weightG ?? 0) };
}

/**
 * Which партияҳо a run was fed from — derived from the feed rows rather than stored.
 *
 * The common case is one, and the screen then simply says «Партия 101». Where a shift
 * worked through two бунтҳо it says both, which is the truthful answer; a single stored
 * партия on the run would have had to pick one of them and would have been wrong.
 */
export async function runBatchNumbers(runId: string): Promise<number[]> {
  const rows = await db
    .selectDistinct({ number: batches.number })
    .from(runFeeds)
    .innerJoin(batches, eq(batches.id, runFeeds.batchId))
    .where(and(eq(runFeeds.runId, runId), isNull(runFeeds.supersedesId)));
  return rows.map((r) => r.number).sort((a, b) => a - b);
}
