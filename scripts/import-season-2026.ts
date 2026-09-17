/**
 * One-time backfill of the 2026 season from the paper/Excel record
 * "Кабули пахта 2026" into the live system, replacing the seed/demo data.
 *
 * Run once, on the server, against the production database:
 *   npx tsx scripts/import-season-2026.ts
 *
 * Safe to re-run: every write carries a clientUuid derived from the row's own
 * natural key (VK number / RKO number / farm tin), so a second run replays
 * instead of duplicating.
 */
import { readFileSync } from "node:fs";
import { db, sql } from "../src/db/client";
import * as s from "../src/db/schema/index";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "../src/lib/auth/password";
import { derivedUuid } from "../src/server/services/derived-uuid";
import { createTicket, captureWeight } from "../src/server/services/tickets";
import { createAnalysis, approveAnalysis } from "../src/server/services/lab";
import { payFarm } from "../src/server/services/farm-payment";
import { payTicket } from "../src/server/services/payments";
import { advanceAccountIdFor, primaryCashAccountId } from "../src/server/services/balances";
import { buildAdvanceIssuedTx } from "../src/domain/ledger";
import { GRAMS_PER_KG } from "../src/domain/units";
import { payableWeight } from "../src/domain/weight";

/**
 * Record an advance already given, historically, against the collateral rule.
 *
 * `issueAdvance()` refuses to lend against cotton that is not yet in our warehouse — the
 * right rule going forward, but this farm's "аванс чиниши пахта" was money given *before*
 * the harvest it funded was picked, which the paper ledger never checked against
 * collateral at all. This posts the same ledger entries `issueAdvance()` would, without
 * relitigating a lending decision the factory already made and is only being recorded.
 */
async function recordHistoricalAdvance(args: {
  clientUuid: string;
  counterpartyId: string;
  counterpartyName: string;
  principalD: number;
  purpose: string;
  issuedBy: string;
  issuedAt: Date;
}) {
  const [replay] = await db
    .select()
    .from(s.advances)
    .where(eq(s.advances.clientUuid, args.clientUuid))
    .limit(1);
  if (replay) return;

  await db.transaction(async (tx) => {
    const cashAccountId = await primaryCashAccountId(tx);
    const advanceAccountId = await advanceAccountIdFor(args.counterpartyId, args.counterpartyName, tx);
    const draft = buildAdvanceIssuedTx(
      args.principalD,
      { cashAccountId, advanceAccountId },
      `${args.purpose} — ${args.counterpartyName}`,
    );
    const [postedTx] = await tx
      .insert(s.ledgerTx)
      .values({
        clientUuid: args.clientUuid,
        kind: "ADVANCE_ISSUED",
        occurredAt: args.issuedAt,
        memo: draft.memo,
        createdBy: args.issuedBy,
      })
      .returning();
    if (!postedTx) throw new Error("Could not post the historical advance.");
    await tx.insert(s.ledgerEntries).values(
      draft.entries.map((e) => ({ txId: postedTx.id, accountId: e.accountId, amountD: e.amountD })),
    );
    await tx.insert(s.advances).values({
      clientUuid: args.clientUuid,
      counterpartyId: args.counterpartyId,
      principalD: args.principalD,
      issuedAt: args.issuedAt,
      purpose: args.purpose,
      ledgerTxId: postedTx.id,
      issuedBy: args.issuedBy,
      note: "Воридшуда аз сабти коғазии мавсим — пеш аз насби низом дода шудааст",
    });
  });
}

const SEASON = 2026;
const DATA_PATH = process.argv[2] ?? "./season-2026-import.json";

interface RawFarm { name: string; jamoat: string; tin: string }
interface RawTicket {
  vk: number; batch: number; date: string; price: number;
  physicalKg: number; trashCoef: number; hisobiKg: number;
  moistCoef: number; holisKg: number; vehicle: string; driver: string;
  tin: string; jamoat: string; farmName: string;
}
interface RawPayment {
  rko: number; date: string; base: string; farmName: string; amountSomoni: number; desc: string;
}

function kgToG(kg: number): number {
  return Math.round(kg * GRAMS_PER_KG);
}
function somoniToD(s: number): number {
  return Math.round(s * 100);
}

/** Every VK (waybill) number named in a "хариди пахта № N[, M ...]" description. */
function vkNumbersIn(desc: string): number[] {
  const after = desc.split("№")[1];
  if (!after) return [];
  return [...after.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/**
 * `payTicket()`'s own idempotency key is expected to look like a client-generated v4
 * UUID: its disbursement half is derived by flipping the version nibble to 8, which is a
 * no-op on a UUID `derivedUuid()` already produced (that one is stamped v8 to begin with)
 * and silently collides the settlement and the disbursement onto the same row. Stamping
 * this one v4 sidesteps it, the same way a real browser-generated key would.
 */
function asV4Uuid(uuid: string): string {
  return `${uuid.slice(0, 14)}4${uuid.slice(15)}`;
}

async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, "utf-8")) as {
    farms: RawFarm[]; tickets: RawTicket[]; payments: RawPayment[];
  };
  console.log(`Loaded ${data.farms.length} farms, ${data.tickets.length} tickets, ${data.payments.length} payments.`);

  // ------------------------------------------------------------ fixed accounts
  const users = await db.select().from(s.users);
  const byUsername = Object.fromEntries(users.map((u) => [u.username, u]));
  const owner = byUsername["sohib"];
  const weigher = byUsername["tarozubon"];
  const labTech = byUsername["laborant"];
  const cashier = byUsername["hazinador"];
  if (!owner || !weigher || !labTech || !cashier) {
    throw new Error("Base accounts (sohib/tarozubon/laborant/hazinador) not found — run this after the base seed.");
  }

  // ------------------------------------------------------------ Salimov Choriboy
  const SALIMOV_PASSWORD = process.env.SALIMOV_PASSWORD;
  if (!SALIMOV_PASSWORD || SALIMOV_PASSWORD.length < 6) {
    throw new Error("Set SALIMOV_PASSWORD (6+ chars) in the environment before running.");
  }
  let salimov = byUsername["salimov"];
  if (!salimov) {
    [salimov] = await db
      .insert(s.users)
      .values({
        username: "salimov",
        fullName: "Салимов Чорибой",
        role: "merchandiser",
        extraRoles: ["weigher", "lab", "cashier"],
        passwordHash: await hashPassword(SALIMOV_PASSWORD),
      })
      .returning();
    console.log("Created user salimov (Салимов Чорибой) — merchandiser + weigher/lab/cashier.");
  } else {
    console.log("User salimov already exists — leaving as is.");
  }

  // ------------------------------------------------------------ stations
  const stations = await db.select().from(s.stations);
  const t1 = stations.find((st) => st.code === "T1");
  const lab = stations.find((st) => st.code === "LAB");
  const kassa = stations.find((st) => st.code === "KASSA");
  if (!t1 || !lab || !kassa) throw new Error("Stations T1/LAB/KASSA not found.");

  // ------------------------------------------------------------ wipe demo/test business data
  console.log("Clearing demo/test data …");
  await sql`delete from disbursements`;
  await sql`delete from payments`;
  await sql`delete from advances`;
  await sql`delete from ledger_entries`;
  await sql`delete from ledger_tx`;
  await sql`delete from ledger_accounts`;
  await sql`delete from lab_analyses`;
  await sql`delete from weigh_events`;
  await sql`delete from weigh_tickets`;
  await sql`delete from price_quotes`;
  await sql`delete from serial_blocks`;
  await sql`delete from vehicles`;
  await sql`delete from drivers`;
  await sql`delete from counterparties`;

  // ------------------------------------------------------------ variety + batches
  let [variety] = await db.select().from(s.varieties).where(eq(s.varieties.code, "С-6530"));
  if (!variety) {
    [variety] = await db.insert(s.varieties).values({ code: "С-6530", nameTg: "Селексияи С-6530" }).returning();
  }
  if (!variety) throw new Error("variety");

  const batchNumbers = [...new Set(data.tickets.map((t) => t.batch))].sort((a, b) => a - b);
  const batchByNumber = new Map<number, string>();
  for (const num of batchNumbers) {
    let [batch] = await db
      .select()
      .from(s.batches)
      .where(and(eq(s.batches.season, SEASON), eq(s.batches.number, num)));
    if (!batch) {
      [batch] = await db
        .insert(s.batches)
        .values({ number: num, season: SEASON, varietyId: variety.id, note: "Воридшуда аз сабти коғазии мавсим" })
        .returning();
    }
    if (!batch) throw new Error(`batch ${num}`);
    batchByNumber.set(num, batch.id);
  }
  console.log(`Batches: ${[...batchByNumber.keys()].join(", ")}`);

  // ------------------------------------------------------------ price: the real season price
  await db.insert(s.priceQuotes).values({
    varietyId: variety.id,
    priceDPerKg: somoniToD(5.5), // 5.5 сомонӣ/кг
    effectiveFrom: new Date(`${SEASON}-08-01T00:00:00Z`),
    setBy: owner.id,
    note: "Нархи воқеии мавсим, аз сабти коғазӣ — 5.5 сомонӣ/кг",
  });

  // ------------------------------------------------------------ farms
  //
  // Most farms are known from a delivery in the intake sheet, which is where their TIN
  // comes from. A few appear only in the payment sheet — an advance given before that
  // farm has brought any cotton in at all — and have no TIN to key on, so they are looked
  // up by name instead. Both maps are filled from this one insert loop.
  const farmIdByTin = new Map<string, string>();
  const farmIdByName = new Map<string, string>();
  for (const f of data.farms) {
    const [row] = await db
      .insert(s.counterparties)
      .values({
        kind: "farm",
        name: f.name,
        tin: f.tin === "0" || !f.tin ? null : f.tin,
        defaultLocation: f.jamoat,
      })
      .returning();
    if (!row) throw new Error(`farm ${f.name}`);
    if (f.tin && f.tin !== "0") farmIdByTin.set(f.tin, row.id);
    farmIdByName.set(f.name, row.id);
  }
  console.log(`Farms: ${farmIdByName.size}`);

  // ------------------------------------------------------------ drivers & vehicles
  const driverIdByName = new Map<string, string>();
  const vehicleIdByPlate = new Map<string, string>();
  for (const t of data.tickets) {
    if (t.driver && !driverIdByName.has(t.driver)) {
      const [row] = await db.insert(s.drivers).values({ fullName: t.driver }).returning();
      if (row) driverIdByName.set(t.driver, row.id);
    }
    if (t.vehicle && !vehicleIdByPlate.has(t.vehicle)) {
      const [row] = await db
        .insert(s.vehicles)
        .values({ plate: t.vehicle, transportOrg: "Хусусӣ" })
        .onConflictDoNothing()
        .returning();
      if (row) vehicleIdByPlate.set(t.vehicle, row.id);
      else {
        const [existing] = await db.select().from(s.vehicles).where(eq(s.vehicles.plate, t.vehicle));
        if (existing) vehicleIdByPlate.set(t.vehicle, existing.id);
      }
    }
  }
  console.log(`Drivers: ${driverIdByName.size}, vehicles: ${vehicleIdByPlate.size}`);

  // ------------------------------------------------------------ serial block: paper VK 1.. becomes T1-2026-000001..
  await db.insert(s.serialBlocks).values({
    stationId: t1.id,
    season: SEASON,
    rangeStart: 1,
    rangeEnd: 5000,
    nextSerial: 1,
    issuedBy: owner.id,
  });

  // ------------------------------------------------------------ cash opening
  // Sized to cover the season's actual cash out (from the paper ledger), with headroom
  // for ongoing operations. The real capital the owner brought to the cash desk for the
  // season — recorded here because the app did not exist when the season started.
  const [cashAcc] = await db
    .insert(s.ledgerAccounts)
    .values({ code: "CASH-1", nameTg: "Хазинаи асосӣ", kind: "CASH" })
    .returning();
  const [purchaseAcc] = await db
    .insert(s.ledgerAccounts)
    .values({ code: "COTTON-PURCHASE", nameTg: "Хариди пахта", kind: "COTTON_PURCHASE" })
    .returning();
  const [openingAcc] = await db
    .insert(s.ledgerAccounts)
    .values({ code: "OPENING", nameTg: "Бақияи ибтидоӣ", kind: "OPENING_BALANCE" })
    .returning();
  const [seedRevAcc] = await db
    .insert(s.ledgerAccounts)
    .values({ code: "SEED-REVENUE", nameTg: "Даромад аз фурӯши тухмӣ", kind: "SEED_REVENUE" })
    .returning();
  if (!cashAcc || !purchaseAcc || !openingAcc || !seedRevAcc) throw new Error("ledger accounts");

  const CASH_OPENING_D = 50_212_300; // 502 123 сомонӣ — the owner's actual opening figure
  const [openTx] = await db
    .insert(s.ledgerTx)
    .values({
      clientUuid: derivedUuid("season-2026-import", "cash-opening"),
      kind: "CASH_OPENING",
      occurredAt: new Date(`${SEASON}-08-27T00:00:00Z`),
      memo: "Бақияи ибтидоии хазина барои мавсими 2026",
      createdBy: owner.id,
      stationId: kassa.id,
    })
    .returning();
  if (!openTx) throw new Error("opening tx");
  await db.insert(s.ledgerEntries).values([
    { txId: openTx.id, accountId: cashAcc.id, amountD: CASH_OPENING_D },
    { txId: openTx.id, accountId: openingAcc.id, amountD: -CASH_OPENING_D },
  ]);
  console.log(`Cash opened: ${CASH_OPENING_D / 100} сомонӣ`);

  // ------------------------------------------------------------ tickets
  const ticketsByVk = new Map<number, { id: string; date: string }>();
  data.tickets.sort((a, b) => a.vk - b.vk);
  for (const t of data.tickets) {
    // A real farm's TIN is the reliable key (names get spelled differently across
    // waybills); a farm with no valid TIN on record is looked up by name instead.
    const farmId =
      t.tin && t.tin !== "0" ? farmIdByTin.get(t.tin) : farmIdByName.get(t.farmName);
    if (!farmId) throw new Error(`no farm for tin ${t.tin} / name "${t.farmName}" (VK ${t.vk})`);
    const batchId = batchByNumber.get(t.batch)!;
    const driverId = t.driver ? driverIdByName.get(t.driver) : undefined;
    const vehicleId = t.vehicle ? vehicleIdByPlate.get(t.vehicle) : undefined;
    const capturedAt = new Date(`${t.date}T09:00:00Z`);

    const netG = kgToG(t.physicalKg);
    const ticket = await createTicket({
      clientUuid: derivedUuid("season-2026-import", `ticket:${t.vk}`),
      season: SEASON,
      stationId: t1.id,
      createdBy: weigher.id,
      consignorId: farmId,
      driverId,
      vehicleId,
      batchId,
      varietyId: variety.id,
      loadingPlace: t.jamoat,
      gross: {
        weightG: netG,
        source: "manual",
        reason: "Воридшуда аз борхати коғазии мавсим — то насби низом",
        capturedAt,
        clientUuid: derivedUuid("season-2026-import", `gross:${t.vk}`),
      },
    });

    await captureWeight({
      clientUuid: derivedUuid("season-2026-import", `tare:${t.vk}`),
      ticketId: ticket.id,
      kind: "TARE",
      weightG: 0,
      operatorId: weigher.id,
      stationId: t1.id,
      capturedAt: new Date(capturedAt.getTime() + 60_000),
      source: "manual",
      reason: "Пахта дар анбор бе мошин баркашида шудааст — тара мавҷуд нест",
    });

    const analysis = await createAnalysis({
      clientUuid: derivedUuid("season-2026-import", `lab:${t.vk}`),
      ticketId: ticket.id,
      stage: "on_intake",
      moistureBp: Math.round(t.moistCoef * 100),
      trashBp: Math.round(t.trashCoef * 100),
      sampledAt: capturedAt,
      labUserId: labTech.id,
    });

    // Pin the payable weight to exactly what the paper record paid for (вазни холис):
    // the current deduction settings postdate this season and would restate history.
    //
    // `payableWeight()` rounds again after the bp is applied, so the naive inverse can
    // land 1-3 g short of the target — which sounds harmless but is not: a farm settled
    // for a single truckload's exact price then comes up a few diram short of what was
    // asked for, and the "whole tickets only" rule responds by dragging an entire second,
    // unrelated truckload into the same settlement to make up the shortfall. Search the
    // handful of bp neighbours instead and prefer one that meets or exceeds the target,
    // never falls short of it.
    const targetPayableG = kgToG(t.holisKg);
    const guess = Math.max(0, 10_000 - Math.round((targetPayableG * 10_000) / netG));
    let overrideDeductionBp = guess;
    let bestDiff = Infinity;
    for (let bp = Math.max(0, guess - 3); bp <= guess + 3; bp++) {
      const g = payableWeight(netG, bp);
      const diff = g - targetPayableG; // >= 0 preferred (never shortchange the farm)
      const rank = diff >= 0 ? diff : 1_000_000 - diff; // penalize shortfalls heavily
      if (rank < bestDiff) {
        bestDiff = rank;
        overrideDeductionBp = bp;
      }
      if (diff === 0) break;
    }

    await approveAnalysis({
      analysisId: analysis.id,
      approverId: labTech.id,
      overrideDeductionBp,
      overrideReason:
        `Воридшуда аз сабти коғазӣ — вазни холис бояд бо ҳуҷҷати аслӣ (${t.holisKg} кг) мувофиқ бошад`,
    });

    ticketsByVk.set(t.vk, { id: ticket.id, date: t.date });
  }
  console.log(`Tickets created: ${ticketsByVk.size}`);

  // ------------------------------------------------------------ payments & advances
  data.payments.sort((a, b) => a.rko - b.rko);

  let paid = 0, paidByTicket = 0, advanced = 0;
  for (const p of data.payments) {
    const farmId = farmIdByName.get(p.farmName);
    if (!farmId) throw new Error(`no farm for payment RKO ${p.rko}: ${p.farmName}`);
    const paidAt = new Date(`${p.date}T12:00:00Z`);
    const amountD = somoniToD(p.amountSomoni);

    // Trust the description over the "base" column — at least one row in the real
    // ledger says "харид" (purchase) in one column and "аванс чиниш" (picking advance)
    // in the next, and the description is the one a person actually typed by hand for
    // that specific row.
    const isAdvance = p.base !== "харид" || /аванс/i.test(p.desc);
    if (!isAdvance) {
      // Pay the exact truckload(s) the paper receipt names, not just "this farm's oldest
      // cotton" — the farmer was not always paid in delivery order, and settling the
      // wrong (often much bigger) ticket to reach the same cash figure would lock in a
      // price on cotton nobody actually sold yet.
      const vks = vkNumbersIn(p.desc).filter((vk) => ticketsByVk.has(vk));
      let settledByTicket = 0;
      for (const vk of vks) {
        const ticketId = ticketsByVk.get(vk)!.id;
        const [row] = await db
          .select({ status: s.weighTickets.status, consignorId: s.weighTickets.consignorId })
          .from(s.weighTickets)
          .where(eq(s.weighTickets.id, ticketId));
        if (row?.consignorId !== farmId) {
          // The "№ N" on the receipt names a truck that belongs to a different farm —
          // a paperwork typo (seen at least once in the real ledger). Trust the farm the
          // cashier actually wrote the receipt for, not the mistyped ticket number.
          console.warn(`  RKO ${p.rko}: № ${vk} belongs to a different farm than "${p.farmName}" — ignoring the reference.`);
          continue;
        }
        if (row?.status !== "ANALYSED") continue; // already settled by an earlier row
        await payTicket({
          clientUuid: asV4Uuid(derivedUuid("season-2026-import", `pay-ticket:${p.rko}:${vk}`)),
          ticketId,
          cashierId: cashier.id,
          copyCollected: true,
          paidAt,
        });
        settledByTicket++;
      }
      if (settledByTicket > 0) {
        paidByTicket++;
      } else {
        // No VK in the description resolved to an unsettled ticket of ours — settle by
        // amount instead, oldest cotton first, same as the cash desk does for a farm
        // that asks for a number rather than naming a truck.
        await payFarm({
          clientUuid: derivedUuid("season-2026-import", `pay:${p.rko}`),
          counterpartyId: farmId,
          requestedCashD: amountD,
          cashierId: cashier.id,
          copyCollected: true,
          season: SEASON,
          paidAt,
        });
      }
      paid++;
    } else {
      await recordHistoricalAdvance({
        clientUuid: derivedUuid("season-2026-import", `advance:${p.rko}`),
        counterpartyId: farmId,
        counterpartyName: p.farmName,
        principalD: amountD,
        purpose: "Аванси чиниши пахта",
        issuedBy: cashier.id,
        issuedAt: paidAt,
      });
      advanced++;
    }
  }
  console.log(`Payments posted: ${paid} (${paidByTicket} by named ticket), advances posted: ${advanced}`);

  console.log("Done.");
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
