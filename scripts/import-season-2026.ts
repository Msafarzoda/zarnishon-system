/**
 * Backfill of the 2026 season from the paper/Excel record "Кабули пахта 2026" into the
 * live system.
 *
 * Run against the production database whenever a new export of that file arrives:
 *   npx tsx scripts/import-season-2026.ts <path-to-export.json>
 *
 * Strictly additive — it never deletes or truncates anything. The very first run
 * replaced the seed/demo data by hand, once; every run since (and every run from here
 * on) only adds VK/RKO rows it has not seen before. Every entity is found-or-created by
 * its own natural key (farm TIN or name, driver name, vehicle plate, VK number, RKO
 * number …) so re-running with the same file, or a file that is the old one plus a few
 * new rows, changes nothing that was already there.
 *
 * This matters beyond neatness: a version of this script used to open by wiping
 * weigh_tickets and friends before reloading them from the file. That is safe only
 * until the app is handling real trucks — the first time it ran against a live
 * database, it deleted a truck that was mid-weighing at the actual scale at that
 * moment, because "delete everything, then reload from the file" cannot tell a truck
 * the file knows nothing about from one it forgot. Never do that again.
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
import { DomainError } from "../src/domain/units";

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
  const [existingPrice] = await db
    .select()
    .from(s.priceQuotes)
    .where(and(eq(s.priceQuotes.varietyId, variety.id), eq(s.priceQuotes.priceDPerKg, somoniToD(5.5))));
  if (!existingPrice) {
    await db.insert(s.priceQuotes).values({
      varietyId: variety.id,
      priceDPerKg: somoniToD(5.5), // 5.5 сомонӣ/кг
      effectiveFrom: new Date(`${SEASON}-08-01T00:00:00Z`),
      setBy: owner.id,
      note: "Нархи воқеии мавсим, аз сабти коғазӣ — 5.5 сомонӣ/кг",
    });
    console.log("Price quote posted: 5.5 сомонӣ/кг.");
  }

  // ------------------------------------------------------------ farms
  //
  // Most farms are known from a delivery in the intake sheet, which is where their TIN
  // comes from. A few appear only in the payment sheet — an advance given before that
  // farm has brought any cotton in at all — and have no TIN to key on, so they are looked
  // up by name instead. Both maps are filled from this one loop, which finds an existing
  // row before it creates one — this runs against a database with real farms already in
  // it every time but the first.
  const farmIdByTin = new Map<string, string>();
  const farmIdByName = new Map<string, string>();
  for (const f of data.farms) {
    const hasTin = Boolean(f.tin) && f.tin !== "0";
    let row = hasTin
      ? (await db.select().from(s.counterparties).where(eq(s.counterparties.tin, f.tin)))[0]
      : (await db.select().from(s.counterparties).where(eq(s.counterparties.name, f.name)))[0];
    if (!row) {
      [row] = await db
        .insert(s.counterparties)
        .values({
          kind: "farm",
          name: f.name,
          tin: hasTin ? f.tin : null,
          defaultLocation: f.jamoat,
        })
        .returning();
    }
    if (!row) throw new Error(`farm ${f.name}`);
    if (hasTin) farmIdByTin.set(f.tin, row.id);
    farmIdByName.set(f.name, row.id);
  }
  console.log(`Farms: ${farmIdByName.size}`);

  // ------------------------------------------------------------ drivers & vehicles
  const driverIdByName = new Map<string, string>();
  const vehicleIdByPlate = new Map<string, string>();
  for (const t of data.tickets) {
    if (t.driver && !driverIdByName.has(t.driver)) {
      let [row] = await db.select().from(s.drivers).where(eq(s.drivers.fullName, t.driver));
      if (!row) [row] = await db.insert(s.drivers).values({ fullName: t.driver }).returning();
      if (row) driverIdByName.set(t.driver, row.id);
    }
    if (t.vehicle && !vehicleIdByPlate.has(t.vehicle)) {
      let [row] = await db.select().from(s.vehicles).where(eq(s.vehicles.plate, t.vehicle));
      if (!row) {
        [row] = await db
          .insert(s.vehicles)
          .values({ plate: t.vehicle, transportOrg: "Хусусӣ" })
          .onConflictDoNothing()
          .returning();
      }
      if (!row) [row] = await db.select().from(s.vehicles).where(eq(s.vehicles.plate, t.vehicle));
      if (row) vehicleIdByPlate.set(t.vehicle, row.id);
    }
  }
  console.log(`Drivers: ${driverIdByName.size}, vehicles: ${vehicleIdByPlate.size}`);

  // ------------------------------------------------------------ serial block: paper VK 1.. becomes T1-2026-000001..
  const [existingBlock] = await db
    .select()
    .from(s.serialBlocks)
    .where(and(eq(s.serialBlocks.stationId, t1.id), eq(s.serialBlocks.season, SEASON)));
  if (!existingBlock) {
    await db.insert(s.serialBlocks).values({
      stationId: t1.id,
      season: SEASON,
      rangeStart: 1,
      rangeEnd: 5000,
      nextSerial: 1,
      issuedBy: owner.id,
    });
    console.log("Serial block opened: T1, season 2026, starting at 1.");
  }

  // ------------------------------------------------------------ cash opening
  // Sized to cover the season's actual cash out (from the paper ledger), with headroom
  // for ongoing operations. The real capital the owner brought to the cash desk for the
  // season — recorded here because the app did not exist when the season started.
  async function ledgerAccount(code: string, nameTg: string, kind: (typeof s.accountKind.enumValues)[number]) {
    let [row] = await db.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.code, code));
    if (!row) [row] = await db.insert(s.ledgerAccounts).values({ code, nameTg, kind }).returning();
    if (!row) throw new Error(`ledger account ${code}`);
    return row;
  }
  const cashAcc = await ledgerAccount("CASH-1", "Хазинаи асосӣ", "CASH");
  await ledgerAccount("COTTON-PURCHASE", "Хариди пахта", "COTTON_PURCHASE");
  const openingAcc = await ledgerAccount("OPENING", "Бақияи ибтидоӣ", "OPENING_BALANCE");
  await ledgerAccount("SEED-REVENUE", "Даромад аз фурӯши тухмӣ", "SEED_REVENUE");

  const CASH_OPENING_D = 50_212_300; // 502 123 сомонӣ — the owner's actual opening figure
  const openingUuid = derivedUuid("season-2026-import", "cash-opening");
  const [existingOpening] = await db.select().from(s.ledgerTx).where(eq(s.ledgerTx.clientUuid, openingUuid));
  if (!existingOpening) {
    const [openTx] = await db
      .insert(s.ledgerTx)
      .values({
        clientUuid: openingUuid,
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
  }

  // ------------------------------------------------------------ tickets
  const ticketsByVk = new Map<number, { id: string; date: string }>();
  let ticketsSkipped = 0;
  data.tickets.sort((a, b) => a.vk - b.vk);
  for (const t of data.tickets) {
    // Already imported on an earlier run of this script — skip the whole ticket, not
    // just the create step. `createTicket`/`captureWeight` replay harmlessly on a
    // repeat clientUuid, but `approveAnalysis` does not: an already-APPROVED analysis
    // throws rather than silently re-approving, which is the right behaviour for a
    // human re-submitting a form and the wrong one for this loop unless it checks first.
    const ticketUuid = derivedUuid("season-2026-import", `ticket:${t.vk}`);
    const [already] = await db
      .select({ id: s.weighTickets.id })
      .from(s.weighTickets)
      .where(eq(s.weighTickets.clientUuid, ticketUuid));
    if (already) {
      ticketsByVk.set(t.vk, { id: already.id, date: t.date });
      ticketsSkipped++;
      continue;
    }

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
  console.log(`Tickets: ${ticketsByVk.size} total (${ticketsByVk.size - ticketsSkipped} new, ${ticketsSkipped} already imported).`);

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
      let alreadyHandled = false;
      for (const vk of vks) {
        const ticketId = ticketsByVk.get(vk)!.id;
        const payClientUuid = asV4Uuid(derivedUuid("season-2026-import", `pay-ticket:${p.rko}:${vk}`));

        // This exact row already settled this exact ticket on an earlier run — keyed on
        // OUR clientUuid, not on the ticket's current status. Checking status instead
        // would be wrong the moment the run is repeated: the ticket is PAID by then for
        // the very reason this check would otherwise skip it, and the row would fall
        // through to the by-amount branch below and find nothing left to settle.
        const [ownPayment] = await db
          .select({ id: s.payments.id })
          .from(s.payments)
          .where(eq(s.payments.clientUuid, payClientUuid));
        if (ownPayment) {
          settledByTicket++;
          alreadyHandled = true;
          continue;
        }

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
        if (row?.status !== "ANALYSED") continue; // settled since by something else entirely
        await payTicket({
          clientUuid: payClientUuid,
          ticketId,
          cashierId: cashier.id,
          copyCollected: true,
          paidAt,
        });
        settledByTicket++;
      }
      const payoutUuid = derivedUuid(derivedUuid("season-2026-import", `pay:${p.rko}`), "payout");
      const [ownFallbackPayout] = await db
        .select({ id: s.disbursements.id })
        .from(s.disbursements)
        .where(eq(s.disbursements.clientUuid, payoutUuid));
      if (settledByTicket > 0) {
        if (!alreadyHandled) paidByTicket++;
      } else if (!ownFallbackPayout) {
        // No VK in the description resolved to an unsettled ticket of ours — settle by
        // amount instead, oldest cotton first, same as the cash desk does for a farm
        // that asks for a number rather than naming a truck.
        try {
          await payFarm({
            clientUuid: derivedUuid("season-2026-import", `pay:${p.rko}`),
            counterpartyId: farmId,
            requestedCashD: amountD,
            cashierId: cashier.id,
            copyCollected: true,
            season: SEASON,
            paidAt,
          });
        } catch (e) {
          // A prior run may have settled this row's tickets fully against an existing
          // advance or balance, moving no cash and so leaving no disbursement row to
          // replay against — the one case `ownFallbackPayout` cannot see. If there is
          // truly nothing left to settle, that is what a repeat of this exact row looks
          // like, not a new error.
          if (!(e instanceof DomainError && e.message.includes("nothing ready to settle"))) throw e;
        }
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
