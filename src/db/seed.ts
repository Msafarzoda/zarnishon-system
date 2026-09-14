/**
 * Seeds a working factory and reproduces the two real documents supplied by the owner,
 * so the system can be checked against the paper it replaces:
 *
 *   Борхат №46, Партия 101 — х-д Билол-Б (РЯМ 5830076707), Газел 22-60, Восиев Б.
 *                            Брутто 3015 кг / Тара 2380 кг / Нетто 635 кг
 *   Форма №9-хл, партия 101 — влажность 9 %, засорённость 2 %
 *
 * Run:  npm run db:push && npm run db:seed
 */
import { randomUUID } from "node:crypto";
import { db, sql } from "./client";
import * as s from "./schema/index";
import { hashPassword } from "../lib/auth/password";
import { deductionBp, netWeight } from "../domain/weight";

const SEASON = 2026;

async function main() {
  console.log("Seeding ЧДММ «ЗАРНИШОН» …");

  // ------------------------------------------------------------ stations
  const [gate, scale, lab, kassa] = await db
    .insert(s.stations)
    .values([
      { code: "GATE", nameTg: "Дарвоза" },
      { code: "T1", nameTg: "Тарозуи автомобилӣ №1" },
      { code: "LAB", nameTg: "Лаборатория" },
      { code: "KASSA", nameTg: "Хазина" },
    ])
    .returning();
  if (!gate || !scale || !lab || !kassa) throw new Error("station seed failed");

  // ------------------------------------------------------------ users
  // Names taken from the signatures on Борхат №46.
  const pw = await hashPassword("zarnishon");
  const [owner, weigher, labTech, cashier, guard, merch] = await db
    .insert(s.users)
    .values([
      { username: "safarov", fullName: "Абдуғафор Сафаров", role: "owner", passwordHash: pw },
      { username: "salimov", fullName: "Салимов Ҷ.", role: "weigher", passwordHash: pw },
      { username: "laborant", fullName: "Лаборант", role: "lab", passwordHash: pw },
      { username: "hazinador", fullName: "Хазинадор", role: "cashier", passwordHash: pw },
      { username: "posbon", fullName: "Посбон", role: "guard", passwordHash: pw },
      { username: "sharipov", fullName: "Шарипов М.", role: "merchandiser", passwordHash: pw },
    ])
    .returning();
  if (!owner || !weigher || !labTech || !cashier || !guard || !merch) {
    throw new Error("user seed failed");
  }

  // ------------------------------------------------------------ serial block
  // The block starts at 46 because Борхат №46 below is the first ticket this system
  // holds — the earlier numbers were written on paper and are not ours to account for.
  // Starting at 1 would make verifySerialGaps() correctly report 45 missing tickets.
  await db.insert(s.serialBlocks).values({
    stationId: scale.id,
    season: SEASON,
    rangeStart: 46,
    rangeEnd: 5000,
    nextSerial: 47, // №46 is used by the seeded ticket
    issuedBy: owner.id,
  });

  // ------------------------------------------------------------ settings
  // See docs/domain.md §3 — the mode is an owner decision and must be confirmed.
  await db.insert(s.factorySettings).values({
    deductionMode: "EXCESS_OVER_NORM",
    normMoistureBp: 800, // 8 %
    normTrashBp: 200, // 2 %
    massBalanceToleranceBp: 50,
    setBy: owner.id,
    reason: "Танзими ибтидоӣ — бояд аз ҷониби соҳиби корхона тасдиқ шавад",
  });

  // ------------------------------------------------------------ reference data
  const [variety] = await db
    .insert(s.varieties)
    .values({ code: "С-6530", nameTg: "Селексияи С-6530" })
    .returning();
  if (!variety) throw new Error("variety seed failed");

  const [bunt1] = await db
    .insert(s.storageLocations)
    .values([
      { code: "BUNT-1", nameTg: "Бунти №1", kind: "bunt" },
      { code: "SKLAD-1", nameTg: "Анбори №1", kind: "sklad" },
      { code: "NAVES-1", nameTg: "Навеси №1", kind: "naves" },
    ])
    .returning();
  if (!bunt1) throw new Error("storage seed failed");

  const [bilol] = await db
    .insert(s.counterparties)
    .values({
      kind: "farm",
      name: "х-д Билол-Б",
      tin: "5830076707",
      defaultLocation: "ч.Бустон",
    })
    .returning();
  if (!bilol) throw new Error("counterparty seed failed");

  const [gazel] = await db
    .insert(s.vehicles)
    .values({ plate: "22-60", model: "Газел 22-60", transportOrg: "Хусусӣ" })
    .returning();
  const [vosiev] = await db
    .insert(s.drivers)
    .values({ fullName: "Восиев Баҳром" })
    .returning();
  if (!gazel || !vosiev) throw new Error("vehicle/driver seed failed");

  // ------------------------------------------------------------ ledger accounts
  const [cash, purchase, seedRev, opening, advBilol] = await db
    .insert(s.ledgerAccounts)
    .values([
      { code: "CASH-1", nameTg: "Хазинаи асосӣ", kind: "CASH" },
      { code: "COTTON-PURCHASE", nameTg: "Хариди пахта", kind: "COTTON_PURCHASE" },
      { code: "SEED-REVENUE", nameTg: "Даромад аз фурӯши тухмӣ", kind: "SEED_REVENUE" },
      { code: "OPENING", nameTg: "Бақияи ибтидоӣ", kind: "OPENING_BALANCE" },
      {
        code: `ADV-${bilol.id.slice(0, 8)}`,
        nameTg: "Қарзи х-д Билол-Б",
        kind: "ADVANCE_RECEIVABLE",
        counterpartyId: bilol.id,
      },
    ])
    .returning();
  if (!cash || !purchase || !seedRev || !opening || !advBilol) {
    throw new Error("ledger account seed failed");
  }

  // Open the drawer with 200 000 сомонӣ so the cash desk has something to pay from.
  const [openTx] = await db
    .insert(s.ledgerTx)
    .values({
      clientUuid: randomUUID(),
      kind: "CASH_OPENING",
      occurredAt: new Date(),
      memo: "Бақияи ибтидоии хазина",
      createdBy: owner.id,
      stationId: kassa.id,
    })
    .returning();
  if (!openTx) throw new Error("opening tx seed failed");
  await db.insert(s.ledgerEntries).values([
    { txId: openTx.id, accountId: cash.id, amountD: 20_000_000 },
    { txId: openTx.id, accountId: opening.id, amountD: -20_000_000 },
  ]);

  // ------------------------------------------------------------ price
  // The owner sets one price for the day, applying to every variety unless he
  // deliberately quotes one separately. A general quote must exist, or nothing is payable.
  await db.insert(s.priceQuotes).values({
    varietyId: null,
    priceDPerKg: 1250, // 12.50 сомонӣ/кг
    effectiveFrom: new Date(`${SEASON}-09-01T00:00:00Z`),
    setBy: owner.id,
    note: "Нархи ибтидоии мавсим",
  });

  // ------------------------------------------------------------ Партия 101
  const [batch101] = await db
    .insert(s.batches)
    .values({
      number: 101,
      season: SEASON,
      varietyId: variety.id,
      grade: 1,
      cottonClass: "1",
      storageLocationId: bunt1.id,
    })
    .returning();
  if (!batch101) throw new Error("batch seed failed");

  // ------------------------------------------------------------ Борхат №46
  const grossG = 3_015_000;
  const tareG = 2_380_000;
  const netG = netWeight(grossG, tareG); // 635 000 g

  const [ticket46] = await db
    .insert(s.weighTickets)
    .values({
      clientUuid: randomUUID(),
      serial: `T1-${SEASON}-000046`,
      season: SEASON,
      serialNumber: 46,
      status: "WEIGHED",
      gate: "DEPARTED",
      batchId: batch101.id,
      consignorId: bilol.id,
      payerId: bilol.id,
      driverId: vosiev.id,
      vehicleId: gazel.id,
      varietyId: variety.id,
      grade: 1,
      cottonClass: "1",
      loadingPlace: "ч.Бустон",
      unloadingPlace: "ч.Бустон",
      grossG,
      tareG,
      netG,
      stationId: scale.id,
      createdBy: weigher.id,
      weighedAt: new Date(`${SEASON}-09-06T18:53:00Z`),
      departedAt: new Date(`${SEASON}-09-06T19:20:00Z`),
    })
    .returning();
  if (!ticket46) throw new Error("ticket seed failed");

  await db.insert(s.weighEvents).values([
    {
      clientUuid: randomUUID(),
      ticketId: ticket46.id,
      kind: "GROSS",
      weightG: grossG,
      source: "manual",
      reason: "Маълумоти ибтидоӣ — аз борхати коғазӣ",
      capturedAt: new Date(`${SEASON}-09-06T18:30:00Z`),
      operatorId: weigher.id,
      stationId: scale.id,
    },
    {
      clientUuid: randomUUID(),
      ticketId: ticket46.id,
      kind: "TARE",
      weightG: tareG,
      source: "manual",
      reason: "Маълумоти ибтидоӣ — аз борхати коғазӣ",
      capturedAt: new Date(`${SEASON}-09-06T18:53:00Z`),
      operatorId: weigher.id,
      stationId: scale.id,
    },
  ]);

  // ------------------------------------------------------------ Форма №9-хл
  const reading = { moistureBp: 900, trashBp: 200 }; // 9 % / 2 %
  const norms = { moistureBp: 800, trashBp: 200 };
  const computed = deductionBp(reading, "EXCESS_OVER_NORM", norms);

  // Every truck is sampled, so the analysis belongs to the Борхат, not the партия.
  await db.insert(s.labAnalyses).values({
    clientUuid: randomUUID(),
    ticketId: ticket46.id,
    stage: "on_intake",
    status: "DRAFT", // deliberately not approved — the lab screen approves it
    moistureBp: reading.moistureBp,
    trashBp: reading.trashBp,
    deductionMode: "EXCESS_OVER_NORM",
    normMoistureBp: norms.moistureBp,
    normTrashBp: norms.trashBp,
    computedDeductionBp: computed,
    storageNote: "Бунти №1",
    sampledAt: new Date(`${SEASON}-09-13T09:00:00Z`),
    createdBy: labTech.id,
  });

  console.log(`  ✓ 4 stations, 6 users (password: zarnishon)`);
  console.log(`  ✓ Партия 101, Борхат T1-${SEASON}-000046, нетто ${netG / 1000} кг`);
  console.log(`  ✓ Форма №9-хл: 9 % / 2 % -> тарҳ ${computed / 100} % (DRAFT, awaiting approval)`);
  console.log(`  ✓ Хазина: 200 000 сомонӣ, нарх 12.50 сомонӣ/кг`);
  console.log("Done.");
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
