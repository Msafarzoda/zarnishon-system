/**
 * Backfill Партия 101's ginning and product sales from the paper records:
 * "Партияи 101" (per-farm mass-balance certificate) + "кип" (195 pressed bales) +
 * "содирот" (чигит/пучоқ shipments).
 *
 * Strictly additive, like scripts/import-season-2026.ts: every entity is found-or-created
 * by its own natural key, and every write carries a clientUuid derived from the row's own
 * identity, so a second run replays instead of duplicating.
 *
 *   npx tsx scripts/import-production-2026.ts <path-to-export.json>
 */
import { readFileSync } from "node:fs";
import { db, sql } from "../src/db/client";
import * as s from "../src/db/schema/index";
import { eq, and } from "drizzle-orm";
import { derivedUuid } from "../src/server/services/derived-uuid";
import { openRun, closeRun, recordFeed, recordOutput, pressBale } from "../src/server/services/production";
import { setProductPrice } from "../src/server/services/product-pricing";
import { sellProduct } from "../src/server/services/product-sales";
import { checkBaleWeight } from "../src/domain/product";
import type { ProductKind } from "../src/domain/product";

const SEASON = 2026;
const BASE = "season-2026-production";
const DATA_PATH = process.argv[2] ?? "./season-2026-production.json";

interface RawBale {
  date: string; shift: string; grade: number; batchNo: number; marka: number; baleNo: number;
  grossKg: number; tareKg: number; netKg: number;
}
interface RawSale {
  num: number; date: string; batch: number; product: string; qtyKg: number;
  priceSomoni: number; amountSomoni: number; receiver: string; vehicle: string; driver: string;
}

function kgToG(kg: number): number {
  return Math.round(kg * 1000);
}
function somoniToD(x: number): number {
  return Math.round(x * 100);
}

async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, "utf-8")) as {
    bales: RawBale[];
    runTotals: { physicalKg: number; conditionedKg: number; kipNetKg: number; chigitKg: number; ulyukKg: number; ugarKg: number };
    sales: RawSale[];
  };
  console.log(`Loaded ${data.bales.length} bales, ${data.sales.length} sales.`);

  const [owner] = await db.select().from(s.users).where(eq(s.users.username, "sohib"));
  const [merch] = await db.select().from(s.users).where(eq(s.users.username, "molshinos"));
  if (!owner || !merch) throw new Error("Base accounts (sohib/molshinos) not found.");

  const [batch101] = await db
    .select()
    .from(s.batches)
    .where(and(eq(s.batches.season, SEASON), eq(s.batches.number, 101)));
  if (!batch101) throw new Error("Батча 101 not found — run the intake import first.");

  // ------------------------------------------------------------ product prices
  // 4.5 сомонӣ/кг чигит, 1 сомонӣ/кг пучоқ — constant across every содирот row.
  for (const [product, priceSomoni] of [["chigit", 4.5], ["puchoq", 1]] as const) {
    const [existing] = await db
      .select()
      .from(s.productPrices)
      .where(eq(s.productPrices.product, product));
    if (!existing) {
      await setProductPrice({
        product,
        priceDPerKg: somoniToD(priceSomoni),
        effectiveFrom: new Date(`${SEASON}-09-01T00:00:00Z`),
        setBy: owner.id,
        note: "Нархи воқеӣ, аз сабти коғазии содирот",
      });
      console.log(`Price set: ${product} = ${priceSomoni} сомонӣ/кг`);
    }
  }

  // ------------------------------------------------------------ the run
  const runUuid = derivedUuid(BASE, "run:101");
  const run = await openRun({
    clientUuid: runUuid,
    operatorId: merch.id,
    startedAt: new Date(`${SEASON}-09-10T06:00:00Z`),
    note: "Партияи 101 — воридшуда аз сабти коғазӣ. Смена: Нуриддин",
  });
  console.log(`Run: ${run.serial} (${run.replayed ? "replayed" : "opened"})`);

  // ------------------------------------------------------------ feed (one bulk entry —
  // runFeeds carries no per-farm attribution; the farms' own contributions are already on
  // their weigh tickets, which is where they stay findable)
  const feedG = kgToG(data.runTotals.conditionedKg);
  await recordFeed({
    clientUuid: derivedUuid(BASE, "feed:101"),
    runId: run.id,
    batchId: batch101.id,
    weightG: feedG,
    source: "primary",
    weighSource: "manual",
    reason: "Воридшуда аз сабти коғазии Партияи 101 — вазни кондитсионӣ",
    operatorId: merch.id,
    fedAt: new Date(`${SEASON}-09-10T06:30:00Z`),
  });
  console.log(`Feed: ${feedG / 1000} кг`);

  // ------------------------------------------------------------ bulk outputs
  const outputs: { product: ProductKind; kg: number }[] = [
    { product: "chigit", kg: data.runTotals.chigitKg },
    { product: "ulyuk", kg: data.runTotals.ulyukKg },
    { product: "puchoq", kg: data.runTotals.ugarKg },
  ];
  for (const o of outputs) {
    await recordOutput({
      clientUuid: derivedUuid(BASE, `output:101:${o.product}`),
      runId: run.id,
      product: o.product,
      weightG: kgToG(o.kg),
      weighSource: "manual",
      reason: "Воридшуда аз сабти коғазии Партияи 101",
      operatorId: merch.id,
      recordedAt: new Date(`${SEASON}-09-16T18:00:00Z`),
    });
    console.log(`Output: ${o.product} = ${o.kg.toFixed(1)} кг`);
  }

  // ------------------------------------------------------------ bales
  let balesPressed = 0;
  for (const b of data.bales) {
    const netG = kgToG(b.netKg);
    const verdict = checkBaleWeight(netG);
    const pressed = await pressBale({
      clientUuid: derivedUuid(BASE, `bale:${b.marka}:${b.baleNo}`),
      runId: run.id,
      batchId: batch101.id,
      weightG: netG,
      grade: String(b.grade),
      reason:
        verdict.kind === "unusual"
          ? "Воридшуда аз сабти коғазии кип — вазни аслӣ аз рӯи тарозуи механикӣ"
          : null,
      operatorId: merch.id,
      pressedAt: new Date(`${b.date}T12:00:00Z`),
    });
    if (!pressed.replayed) balesPressed++;
  }
  console.log(`Bales: ${data.bales.length} total (${balesPressed} new).`);

  // ------------------------------------------------------------ close the run
  const closed = await closeRun(run.id, merch.id);
  console.log(`Run closed: ${closed.alreadyClosed ? "already" : "now"}.`);

  // ------------------------------------------------------------ sales
  const buyerIdByName = new Map<string, string>();
  const vehicleIdByPlate = new Map<string, string>();
  let sold = 0;
  for (const sale of data.sales) {
    let buyerId = buyerIdByName.get(sale.receiver);
    if (!buyerId) {
      let [row] = await db.select().from(s.counterparties).where(eq(s.counterparties.name, sale.receiver));
      if (!row) {
        [row] = await db
          .insert(s.counterparties)
          .values({ kind: "local", name: sale.receiver })
          .returning();
      }
      buyerId = row!.id;
      buyerIdByName.set(sale.receiver, buyerId);
    }

    let vehicleId = sale.vehicle ? vehicleIdByPlate.get(sale.vehicle) : undefined;
    if (sale.vehicle && !vehicleId) {
      let [row] = await db.select().from(s.vehicles).where(eq(s.vehicles.plate, sale.vehicle));
      if (!row) {
        [row] = await db
          .insert(s.vehicles)
          .values({ plate: sale.vehicle, transportOrg: "Хусусӣ" })
          .onConflictDoNothing()
          .returning();
      }
      if (!row) [row] = await db.select().from(s.vehicles).where(eq(s.vehicles.plate, sale.vehicle));
      vehicleId = row?.id;
      if (vehicleId) vehicleIdByPlate.set(sale.vehicle, vehicleId);
    }

    const product: ProductKind = sale.product.startsWith("пучо") ? "puchoq" : "chigit";
    const grossG = kgToG(sale.qtyKg);

    const result = await sellProduct({
      clientUuid: derivedUuid(BASE, `sale:${sale.num}`),
      product,
      buyerId,
      tareG: 0,
      grossG,
      tareSource: "manual",
      grossSource: "manual",
      weighReason: "Воридшуда аз сабти коғазии содирот",
      vehicleId,
      paidNowD: 0,
      soldBy: merch.id,
      note: `№${sale.num}`,
      soldAt: new Date(`${sale.date}T12:00:00Z`),
    });
    if (!result.replayed) sold++;
  }
  console.log(`Sales: ${data.sales.length} total (${sold} new).`);

  console.log("Done.");
}

main().then(() => sql.end()).catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
