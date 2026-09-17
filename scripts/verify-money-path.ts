/**
 * End-to-end check of the money path against a real database.
 *
 * Run against a freshly seeded database:
 *     npm run db:push && npm run db:seed && npm run verify
 *
 * It walks the whole path the factory walks — approve the lab analysis, pay the farmer,
 * try to pay him twice, lend a farm money and watch it come back out of his next load,
 * weigh a truck into a партия that is already approved — and then asks the integrity
 * checks whether the books still hold. Every assertion is a rule from docs/domain.md.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, sql } from "../src/db/client";
import * as s from "../src/db/schema/index";
import { approveAnalysis, createAnalysis } from "../src/server/services/lab";
import { payTicket } from "../src/server/services/payments";
import { disburseCash } from "../src/server/services/disbursements";
import { payFarm, previewFarmPayment } from "../src/server/services/farm-payment";
import { farmCollateral } from "../src/server/services/collateral";
import { issueAdvance } from "../src/server/services/advances";
import { captureWeight, createTicket } from "../src/server/services/tickets";
import { cashOnHandD, farmPayableD, outstandingAdvanceD,
         totalFarmPayableD } from "../src/server/services/balances";
import { runAllChecks } from "../src/server/services/integrity";
import {
  closeRun, openRun, pressBale, recordFeed, recordOutput, runMassBalance,
} from "../src/server/services/production";
import {
  lookupBaleBySerial, productStock, receiveSalePayment, sellProduct,
} from "../src/server/services/product-sales";
import { setProductPrice } from "../src/server/services/product-pricing";
import { totalBuyerReceivableD } from "../src/server/services/balances";
import { DomainError, diramToSomoniString, gramsToKgString } from "../src/domain/units";

const SEASON = 2026;
let checks = 0;
const ok = (label: string) => {
  checks++;
  console.log("  ✓", label);
};

async function main() {
  const [cashier] = await db.select().from(s.users).where(eq(s.users.username, "hazinador"));
  const [labTech] = await db.select().from(s.users).where(eq(s.users.username, "laborant"));
  const [weigher] = await db.select().from(s.users).where(eq(s.users.username, "tarozubon"));
  const [owner] = await db.select().from(s.users).where(eq(s.users.username, "sohib"));
  const [scale] = await db.select().from(s.stations).where(eq(s.stations.code, "T1"));
  const [farm] = await db.select().from(s.counterparties).where(eq(s.counterparties.tin, "0000000001"));
  const [batch] = await db
    .select().from(s.batches)
    .where(and(eq(s.batches.season, SEASON), eq(s.batches.number, 101)));
  assert(cashier && labTech && weigher && owner && scale && farm && batch,
         "seed data missing — run db:seed");

  const [ticket46] = await db
    .select().from(s.weighTickets)
    .where(eq(s.weighTickets.serial, `T1-${SEASON}-000046`));
  assert(ticket46, "Борхат №46 missing");

  const openingCash = await cashOnHandD();

  // ---------------------------------------------------------------- lab
  console.log("\nЛаборатория — Форма №9-хл");

  await assert.rejects(
    () => payTicket({
      clientUuid: randomUUID(), ticketId: ticket46.id,
      cashierId: cashier.id, copyCollected: true,
    }),
    /тасдиқ нашудааст/,
    "must refuse payment before the lab approves",
  );
  ok("payment refused while the лаборатория has not approved партия 101");

  const [analysis] = await db
    .select().from(s.labAnalyses).where(eq(s.labAnalyses.ticketId, ticket46.id));
  assert(analysis, "the seeded per-truck analysis is missing");

  const approved = await approveAnalysis({ analysisId: analysis.id, approverId: labTech.id });
  assert.equal(approved.effectiveDeductionBp, 100, "9 % moisture over an 8 % norm is a 1 % deduction");
  assert.equal(approved.ticketsPromoted, 1, "approving one truck's sample promotes that truck");
  ok("approving Борхат №46's own sample deducts 1 % and makes that one truck payable");

  await assert.rejects(
    () => approveAnalysis({ analysisId: analysis.id, approverId: labTech.id }),
    /аллакай тасдиқ шудааст/,
    "an approved analysis is immutable",
  );
  ok("the same analysis cannot be approved twice");

  // ---------------------------------------------------------------- payment
  console.log("\nПардохт — Борхат №46");

  const payment = await payTicket({
    clientUuid: randomUUID(), ticketId: ticket46.id,
    cashierId: cashier.id, copyCollected: true,
  });

  assert.equal(gramsToKgString(payment.payableG, 2), "628.65");
  assert.equal(payment.grossAmountD, 785_813);
  assert.equal(payment.cashPayableD, 785_813);
  assert.equal(payment.advanceOffsetD, 0);
  ok(`635 кг → ${gramsToKgString(payment.payableG, 2)} кг × 12.50 = ` +
     `${diramToSomoniString(payment.cashPayableD)} сомонӣ`);

  assert.equal(payment.disbursedD, 785_813, "the default is to hand over the whole amount");
  assert.equal(payment.farmBalanceD, 0, "nothing left owed when the whole amount is handed over");
  assert.equal(
    await cashOnHandD(), openingCash - 785_813,
    "cash on hand must fall by exactly what was handed over",
  );
  ok("нақди дар хазина fell by exactly the cash paid");

  // The control that replaces the stamped paper copy.
  await assert.rejects(
    () => payTicket({
      clientUuid: randomUUID(), ticketId: ticket46.id,
      cashierId: cashier.id, copyCollected: true,
    }),
    /аллакай пардохт шудааст/,
    "a ticket may be paid at most once",
  );
  ok("the same borkhat cannot be paid a second time");

  // The offline queue replaying an operation it already sent.
  const replayUuid = randomUUID();
  const [t47] = await newTruck({ weigher, scale, farm, batch, lab: labTech, grossKg: 4000, tareKg: 3000 });
  const first = await payTicket({
    clientUuid: replayUuid, ticketId: t47,
    cashierId: cashier.id, copyCollected: true,
  });
  const replay = await payTicket({
    clientUuid: replayUuid, ticketId: t47,
    cashierId: cashier.id, copyCollected: true,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.paymentId, first.paymentId, "a replay returns the original payment");
  ok("replaying a queued payment returns the original, it does not pay twice");

  // -------------------------------------------------- part payment / pay later
  console.log("\nПардохти қисман — a farm that wants 2 000 of its 6 000");

  // 1 000 кг at no deduction and 6.00 сомонӣ/кг settles at exactly 6 000 сомонӣ, so the
  // arithmetic in this section can be read at a glance.
  await db.insert(s.priceQuotes).values({
    priceDPerKg: 600,
    effectiveFrom: new Date(Date.now() - 60_000),
    setBy: owner.id,
    note: "тафтиши система — пардохти қисман",
  });

  const [partId] = await newTruck({
    weigher, scale, farm, batch, lab: labTech,
    grossKg: 5000, tareKg: 4000, moistureBp: 800, trashBp: 200,
  });

  const cashBeforePart = await cashOnHandD();
  const part = await payTicket({
    clientUuid: randomUUID(), ticketId: partId,
    cashierId: cashier.id, copyCollected: true,
    disburseD: 200_000, // 2 000 сомонӣ of the 6 000
  });

  assert.equal(part.cashPayableD, 600_000, "1 000 кг × 6.00 сомонӣ = 6 000 сомонӣ");
  assert.equal(part.disbursedD, 200_000);
  assert.equal(part.farmBalanceD, 400_000, "the other 4 000 stays owed to the farm");
  assert.equal(await cashOnHandD(), cashBeforePart - 200_000,
               "only what was handed over may leave the drawer");
  assert.equal(await farmPayableD(farm.id), 400_000);
  ok("settled 6 000 сомонӣ, handed over 2 000, 4 000 left on the farm's account");

  await assert.rejects(
    () => disburseCash({
      clientUuid: randomUUID(), counterpartyId: farm.id,
      amountD: 400_001, cashierId: cashier.id,
    }),
    /талабгор аст/,
    "a farm cannot be paid more than it is owed",
  );
  ok("paying one diram more than the farm is owed is refused");

  const cashBeforeRest = await cashOnHandD();
  const rest = await disburseCash({
    clientUuid: randomUUID(), counterpartyId: farm.id,
    amountD: 150_000, cashierId: cashier.id, note: "қисми дуюм",
  });
  assert.equal(rest.balanceAfterD, 250_000);
  assert.equal(await cashOnHandD(), cashBeforeRest - 150_000);
  assert.equal(await farmPayableD(farm.id), 250_000);
  ok(`instalment of 1 500 сомонӣ paid, ${diramToSomoniString(250_000)} сомонӣ still owed`);

  // The offline queue replaying a disbursement it already sent.
  const payoutUuid = randomUUID();
  const firstPayout = await disburseCash({
    clientUuid: payoutUuid, counterpartyId: farm.id, amountD: 50_000, cashierId: cashier.id,
  });
  const replayPayout = await disburseCash({
    clientUuid: payoutUuid, counterpartyId: farm.id, amountD: 50_000, cashierId: cashier.id,
  });
  assert.equal(replayPayout.replayed, true);
  assert.equal(replayPayout.disbursementId, firstPayout.disbursementId);
  assert.equal(await farmPayableD(farm.id), 200_000, "a replay must not pay a second time");
  ok("replaying a queued cash payout returns the original, it does not pay twice");

  console.log("\nБаъдтар пардохт мекунем — settling with no cash at all");

  const [laterId] = await newTruck({
    weigher, scale, farm, batch, lab: labTech,
    grossKg: 3000, tareKg: 2000, moistureBp: 800, trashBp: 200,
  });
  const cashBeforeLater = await cashOnHandD();
  const later = await payTicket({
    clientUuid: randomUUID(), ticketId: laterId,
    cashierId: cashier.id, copyCollected: true,
    disburseD: 0,
  });
  assert.equal(later.disbursedD, 0);
  assert.equal(later.disbursementId, null, "no cash moved, so there is no cash receipt");
  assert.equal(await cashOnHandD(), cashBeforeLater, "the drawer is untouched");
  assert.equal(later.farmBalanceD, 200_000 + 600_000);
  ok("a ticket settled with nothing handed over leaves the whole amount owed");

  await assert.rejects(
    () => payTicket({
      clientUuid: randomUUID(), ticketId: laterId,
      cashierId: cashier.id, copyCollected: true,
    }),
    /аллакай пардохт шудааст/,
    "settling with no cash still closes the ticket for good",
  );
  ok("a ticket settled on credit cannot be settled again");

  console.log("\nХазина камӣ мекунад — the drawer cannot cover what is owed");

  // 60 000 кг at 6.00 сомонӣ settles at 360 000 сомонӣ, well past anything in the drawer.
  const [bigId] = await newTruck({
    weigher, scale, farm, batch, lab: labTech,
    grossKg: 64_000, tareKg: 4_000, moistureBp: 800, trashBp: 200,
  });
  const big = await payTicket({
    clientUuid: randomUUID(), ticketId: bigId,
    cashierId: cashier.id, copyCollected: true, disburseD: 0,
  });
  assert.equal(big.cashPayableD, 36_000_000);

  const drawer = await cashOnHandD();
  assert.ok(await farmPayableD(farm.id) > drawer, "the farm is owed more than we hold");

  await assert.rejects(
    () => disburseCash({
      clientUuid: randomUUID(), counterpartyId: farm.id,
      amountD: drawer + 1, cashierId: cashier.id,
    }),
    /Дар хазина/,
    "the drawer cannot pay out more than it holds",
  );
  ok("paying out more than the drawer holds is refused, in Tajik, at the desk");

  // And what it *can* pay, it pays — the farm leaves with something. Ten сомонӣ is left
  // in the drawer so the sections after this one still have a working cash desk.
  const partialOfBig = await disburseCash({
    clientUuid: randomUUID(), counterpartyId: farm.id,
    amountD: drawer - 1_000, cashierId: cashier.id, note: "то охири хазина",
  });
  assert.equal(await cashOnHandD(), 1_000, "the drawer may be emptied, but not overdrawn");
  assert.ok(partialOfBig.balanceAfterD > 0, "the rest stays owed");
  ok(`drawer paid down to its last сомонӣ, ` +
     `${diramToSomoniString(partialOfBig.balanceAfterD)} сомонӣ still owed to the farm`);

  // An advance is cash leaving the same drawer, and was not checking it at all. Cotton is
  // weighed in first so this farm has collateral — otherwise the lending limit refuses it
  // before the drawer ever gets a say, and the guard under test is never reached.
  await newTruck({
    weigher, scale, farm, batch, lab: labTech,
    grossKg: 12_000, tareKg: 2_000, moistureBp: 800, trashBp: 200,
  });
  await assert.rejects(
    () => issueAdvance({
      clientUuid: randomUUID(), counterpartyId: farm.id,
      principalD: 300_000, purpose: "тафтиш", issuedBy: cashier.id,
    }),
    /Дар хазина/,
    "an advance cannot be lent out of an empty drawer",
  );
  ok("lending more қарз than the drawer holds is refused — нақд can never go negative");

  // Put the day's takings back so the sections below have a cash desk again.
  await db.insert(s.ledgerTx).values({
    clientUuid: randomUUID(), kind: "CASH_ADJUSTMENT",
    occurredAt: new Date(), memo: "Тафтиш — пур кардани хазина", createdBy: owner.id,
  }).returning().then(async ([t]) => {
    const [cashAcc] = await db.select().from(s.ledgerAccounts)
      .where(eq(s.ledgerAccounts.kind, "CASH")).limit(1);
    const [openAcc] = await db.select().from(s.ledgerAccounts)
      .where(eq(s.ledgerAccounts.kind, "OPENING_BALANCE")).limit(1);
    await db.insert(s.ledgerEntries).values([
      { txId: t!.id, accountId: cashAcc!.id, amountD: 20_000_000 },
      { txId: t!.id, accountId: openAcc!.id, amountD: -20_000_000 },
    ]);
  });

  // ---------------------------------------------------------------- advance
  console.log("\nҚарз — advance recovered from the next load");

  const cashBeforeAdvance = await cashOnHandD();
  await issueAdvance({
    clientUuid: randomUUID(), counterpartyId: farm.id,
    principalD: 300_000, purpose: "Барои чиниши пахта", issuedBy: cashier.id,
  });
  assert.equal(await cashOnHandD(), cashBeforeAdvance - 300_000);
  assert.equal(await outstandingAdvanceD(farm.id), 300_000);
  ok("3 000 сомонӣ left the drawer and landed on the farm's account");

  const [t48] = await newTruck({ weigher, scale, farm, batch, lab: labTech, grossKg: 3015, tareKg: 2380 });
  const settled = await payTicket({
    clientUuid: randomUUID(), ticketId: t48,
    cashierId: cashier.id, copyCollected: true,
  });
  assert.equal(settled.advanceOffsetD, 300_000);
  assert.equal(
    settled.cashPayableD, settled.grossAmountD - 300_000,
    "the advance comes off before any cash is owed",
  );
  assert.equal(await outstandingAdvanceD(farm.id), 0, "the advance is fully recovered");
  ok(`the 3 000 сомонӣ қарз came off: ${diramToSomoniString(settled.cashPayableD)} сомонӣ handed over`);

  // ---------------------------------------------------------------- late truck
  console.log("\nБе лаборатория — a truck that has not been sampled cannot be paid");
  const [unsampledId, unsampledSerial] = await newTruck({
    weigher, scale, farm, batch, grossKg: 2500, tareKg: 2000, skipLab: true,
  });
  await assert.rejects(
    () => payTicket({
      clientUuid: randomUUID(), ticketId: unsampledId,
      cashierId: cashier.id, copyCollected: true,
    }),
    /лаборатория/,
    "a load that skipped the lab must not be payable",
  );
  ok(`${unsampledSerial} was weighed but not sampled — payment refused`);

  console.log("\nМошини дертар — a truck sampled right after weighing");

  const [lateId, lateSerial] = await newTruck({
    weigher, scale, farm, batch, lab: labTech, grossKg: 5000, tareKg: 4000,
  });
  const [late] = await db.select().from(s.weighTickets).where(eq(s.weighTickets.id, lateId));
  assert.equal(
    late?.status, "ANALYSED",
    "its own sample is approved, so this ticket must be payable",
  );
  ok(`${lateSerial} became payable once the lab approved its own sample`);

  // ------------------------------------------------- lending against cotton
  console.log("\nҚарз аз рӯи пахтаи дар анбор — the lending limit");

  // A farm with nothing in the shed is the plainest case.
  const [emptyFarm] = await db
    .insert(s.counterparties)
    .values({ name: "х-д Санҷиши Холӣ", kind: "farm", tin: "7010000001" })
    .returning();
  assert(emptyFarm);

  const emptyCollateral = await farmCollateral(emptyFarm.id);
  assert.equal(emptyCollateral.cottonInHandG, 0);
  assert.equal(emptyCollateral.headroomD, 0);
  await assert.rejects(
    () => issueAdvance({
      clientUuid: randomUUID(), counterpartyId: emptyFarm.id,
      principalD: 10_000, purpose: "тафтиш", issuedBy: cashier.id,
    }),
    /пахта надорад/,
    "a farm with no cotton in the warehouse can borrow nothing",
  );
  ok("a farm with an empty shed is lent nothing at all");

  // 3 000 kg in hand at 1 сомонӣ/kg — the owner's own example.
  const [collatFarm] = await db
    .insert(s.counterparties)
    .values({ name: "х-д Санҷиши Гарав", kind: "farm", tin: "7010000002" })
    .returning();
  assert(collatFarm);
  await newTruck({
    weigher, scale, farm: collatFarm, batch, lab: labTech,
    grossKg: 5_000, tareKg: 2_000, moistureBp: 800, trashBp: 200,
  });

  const collat = await farmCollateral(collatFarm.id);
  assert.equal(collat.cottonInHandG, 3_000_000, "3 000 кг in the warehouse");
  assert.equal(collat.maxAdvanceD, 300_000, "3 000 сомонӣ at 1 сомонӣ per kg");
  assert.equal(collat.headroomD, 300_000);
  ok(`3 000 кг пахта → ҳадди қарз ${diramToSomoniString(collat.maxAdvanceD)} сомонӣ`);

  await assert.rejects(
    () => issueAdvance({
      clientUuid: randomUUID(), counterpartyId: collatFarm.id,
      principalD: 300_001, purpose: "тафтиш", issuedBy: cashier.id,
    }),
    /Ҳадди қарз/,
    "one diram over the collateral limit is refused",
  );
  ok("borrowing one diram past the cotton standing behind it is refused");

  await issueAdvance({
    clientUuid: randomUUID(), counterpartyId: collatFarm.id,
    principalD: 250_000, purpose: "Барои чиниши пахта", issuedBy: cashier.id,
  });
  const afterLoan = await farmCollateral(collatFarm.id);
  assert.equal(afterLoan.headroomD, 50_000, "what is already borrowed counts against it");
  ok("500 сомонӣ of headroom left after lending 2 500 against 3 000 сомонӣ of cotton");

  // ------------------------------------------- paying a farm an amount it asks for
  console.log("\nПардохт ба хоҷагӣ — «6 000 сомонӣ мехоҳам»");

  const [amountFarm] = await db
    .insert(s.counterparties)
    .values({ name: "х-д Санҷиши Маблағ", kind: "farm", tin: "7010000003" })
    .returning();
  assert(amountFarm);

  // Three deliveries, 5 т then 10 т then 5 т — 20 т in hand, exactly the owner's example.
  // At 6.00 сомонӣ/кг and no deduction they are worth 30 000, 60 000 and 30 000 сомонӣ.
  for (const tonnes of [5, 10, 5]) {
    await newTruck({
      weigher, scale, farm: amountFarm, batch, lab: labTech,
      grossKg: tonnes * 1000 + 2000, tareKg: 2000, moistureBp: 800, trashBp: 200,
    });
  }

  const inHand = await farmCollateral(amountFarm.id);
  assert.equal(inHand.cottonInHandG, 20_000_000, "20 т in hand");
  ok("20 т supplied across three борхатҳо, all standing in the warehouse");

  const preview = await previewFarmPayment({
    counterpartyId: amountFarm.id, requestedCashD: 600_000, // 6 000 сомонӣ
  });
  assert.equal(preview.tickets.length, 1, "the oldest борхат alone covers 6 000 сомонӣ");
  assert.equal(preview.cashPayableD, 3_000_000, "5 т × 6.00 = 30 000 сомонӣ");
  assert.equal(preview.disburseD, 600_000);
  assert.equal(preview.remainderD, 2_400_000, "the rest of that борхат stays on the balance");
  ok("asking for 6 000 сомонӣ settles the oldest борхат and leaves 24 000 on account");

  const cashBeforeFarm = await cashOnHandD();
  const paidFarm = await payFarm({
    clientUuid: randomUUID(), counterpartyId: amountFarm.id,
    requestedCashD: 600_000, cashierId: cashier.id, copyCollected: true,
  });
  assert.equal(paidFarm.settled.length, 1);
  assert.equal(paidFarm.disbursedD, 600_000);
  assert.equal(paidFarm.farmBalanceD, 2_400_000);
  assert.equal(await cashOnHandD(), cashBeforeFarm - 600_000,
               "only what the farm asked for leaves the drawer");
  ok(`handed over ${diramToSomoniString(paidFarm.disbursedD)} сомонӣ, ` +
     `${diramToSomoniString(paidFarm.farmBalanceD)} сомонӣ left on the farm's account`);

  // Settled cotton stops being collateral.
  const afterSettling = await farmCollateral(amountFarm.id);
  assert.equal(afterSettling.cottonInHandG, 15_000_000,
               "the 5 т that was settled is no longer collateral");
  ok("cotton that has been settled drops out of the lending limit");

  // Money already owed is spent before any more cotton is sold. The farm is sitting on
  // 24 000 сомонӣ from the settlement above, so a request that size sells nothing at all.
  const collectOnly = await previewFarmPayment({
    counterpartyId: amountFarm.id, requestedCashD: 2_000_000, // 20 000 сомонӣ
  });
  assert.equal(collectOnly.tickets.length, 0, "the balance covers it — no борхат is settled");
  assert.equal(collectOnly.fromBalanceD, 2_000_000);
  assert.equal(collectOnly.disburseD, 2_000_000);
  ok("a farm collecting money it is already owed has no cotton sold at today's price");

  // A bigger ask spends the balance first, then reaches down the list for the rest.
  const reachFurther = await previewFarmPayment({
    counterpartyId: amountFarm.id, requestedCashD: 7_000_000, // 70 000 сомонӣ
  });
  assert.equal(reachFurther.fromBalanceD, 2_400_000, "the 24 000 on account goes first");
  assert.equal(
    reachFurther.tickets.length, 1,
    "only 46 000 is left to find, and the 10 т борхат covers it",
  );
  assert.equal(reachFurther.shortfallD, 0);
  ok("a larger request spends the balance, then sells the oldest борхат that covers the rest");

  // More than everything the farm has, cotton and balance together.
  const tooMuch = await previewFarmPayment({
    counterpartyId: amountFarm.id, requestedCashD: 20_000_000,
  });
  assert.equal(tooMuch.cashPayableD, 9_000_000, "15 т × 6.00 = 90 000 сомонӣ of cotton");
  assert.equal(tooMuch.fromBalanceD, 2_400_000);
  assert.equal(tooMuch.disburseD, 11_400_000, "90 000 of cotton plus 24 000 on account");
  assert.equal(tooMuch.shortfallD, 8_600_000);
  ok("asking for more than the farm has reports the shortfall, it does not overpay");

  // ---------------------------------------------------------------- integrity
  console.log("\nТафтиш — integrity of the books");

  const findings = await runAllChecks(SEASON);
  const serious = findings.filter((f) => f.severity === "alarm");
  if (serious.length > 0) {
    console.error(serious);
    throw new Error(`${serious.length} integrity failure(s)`);
  }
  ok(`ledger balances, weights match their record, payments match the ledger — ` +
     `${findings.length} warning(s), 0 failures`);

  // ---------------------------------------------------------------- §7: the factory
  console.log("\nКоркард ва фурӯш — §7");

  const run = await openRun({ clientUuid: randomUUID(), operatorId: owner.id });
  ok(`басти ${run.serial} кушода шуд`);

  await assert.rejects(
    () => recordFeed({
      clientUuid: randomUUID(), runId: run.id, weightG: 1_000_000,
      operatorId: owner.id,
    }),
    (e: Error) => e instanceof DomainError,
    "a hand-entered feed weight must demand a reason",
  );
  ok("вазни дастӣ бе сабаб қабул намешавад");

  // 100 t in, and the outputs that a real shift would give: 57 % seed, 33 % lint,
  // 1 % улюк, 8 % пучоқ. That leaves 1 % unaccounted for, inside the 3 % limit.
  await recordFeed({
    clientUuid: randomUUID(), runId: run.id, weightG: 100_000_000,
    batchId: batch.id, reason: "конвейер", operatorId: owner.id,
  });
  for (const [product, g] of [
    ["chigit", 57_000_000], ["ulyuk", 1_000_000], ["puchoq", 8_000_000],
  ] as const) {
    await recordOutput({
      clientUuid: randomUUID(), runId: run.id, product, weightG: g,
      reason: "тарозуи анбор", operatorId: owner.id,
    });
  }

  await assert.rejects(
    () => recordOutput({
      clientUuid: randomUUID(), runId: run.id, product: "kip", weightG: 33_000_000,
      reason: "x", operatorId: owner.id,
    }),
    (e: Error) => e instanceof DomainError,
    "кип must never be recorded as a bulk output",
  );
  ok("кип ҳамчун маҳсулоти фалокӣ сабт намешавад");

  // 155 bales at 213 kg is 33 015 kg — 33 % of the feed, inside the lint band.
  const baleSerials: string[] = [];
  for (let i = 0; i < 155; i++) {
    const b = await pressBale({
      clientUuid: randomUUID(), runId: run.id, batchId: batch.id,
      weightG: 213_000, operatorId: owner.id,
    });
    baleSerials.push(b.serial);
  }
  assert.equal(baleSerials[0], `K-${SEASON}-101-00001`);
  assert.equal(baleSerials[154], `K-${SEASON}-101-00155`);
  ok("рақами кип партияро мебарад — K-2026-101-00001 … 00155");

  const balance = await runMassBalance(run.id);
  assert.equal(balance.severity, "ok",
    `mass balance should be clean, got ${JSON.stringify(balance.findings)}`);
  ok(`тавозун дуруст — талафот ${(balance.lossBp / 100).toFixed(2)} %`);

  await closeRun(run.id, owner.id);
  await assert.rejects(
    () => pressBale({
      clientUuid: randomUUID(), runId: run.id, batchId: batch.id,
      weightG: 213_000, operatorId: owner.id,
    }),
    (e: Error) => e instanceof DomainError,
    "a closed run must not take more bales",
  );
  ok("ба басти пӯшида чизе илова намешавад");

  // ---- selling it
  const [buyer] = await db
    .insert(s.counterparties)
    .values({
      clientUuid: randomUUID(), kind: "local", name: "Ҳамсояи харидор",
      createdBy: owner.id,
    })
    .returning();
  assert(buyer, "could not create a buyer");

  await assert.rejects(
    () => sellProduct({
      clientUuid: randomUUID(), product: "chigit", buyerId: buyer.id,
      tareG: 8_000_000, grossG: 20_000_000, soldBy: owner.id,
      weighReason: "тарозу",
    }),
    (e: Error) => e instanceof DomainError,
    "selling before the owner has set a price must be refused",
  );
  ok("бе нархи соҳиб чизе фурӯхта намешавад");

  await setProductPrice({ product: "chigit", priceDPerKg: 320, setBy: owner.id });
  await setProductPrice({ product: "kip", priceDPerKg: 2_500, setBy: owner.id });
  await assert.rejects(
    () => setProductPrice({ product: "kip", priceDPerKg: 2_600, setBy: cashier.id }),
    (e: Error) => e instanceof DomainError,
    "a cashier must never set a selling price",
  );
  ok("нархро танҳо соҳиб мегузорад");

  const cashBeforeSale = await cashOnHandD();

  // 12 t of чигит at 3.20, paid in full at the gate — the ordinary local sale.
  const seedSale = await sellProduct({
    clientUuid: randomUUID(), product: "chigit", buyerId: buyer.id,
    tareG: 8_000_000, grossG: 20_000_000,
    tareSource: "indicator", grossSource: "indicator",
    tareRaw: "\x02+0080000\x03", grossRaw: "\x02+0200000\x03",
    paidNowD: 3_840_000, soldBy: owner.id,
  });
  assert.equal(seedSale.weightG, 12_000_000);
  assert.equal(seedSale.amountD, 3_840_000);
  ok(`чигит фурӯхта шуд — ${gramsToKgString(seedSale.weightG, 0)} кг, ` +
     `${diramToSomoniString(seedSale.amountD)} сомонӣ`);

  assert.equal(await cashOnHandD(), cashBeforeSale + 3_840_000);
  ok("пули фурӯш ба ҳамон хазина даромад, ки ба хоҷагиҳо пул медиҳад");
  assert.equal(await totalBuyerReceivableD(), 0);
  ok("харидор чизе қарздор намонд");

  // 100 bales on credit — кип goes at the end of the season and is rarely paid at once.
  const [balesToSell] = [await db.select({ id: s.bales.id, serial: s.bales.serial })
    .from(s.bales).limit(100)];
  const kipSale = await sellProduct({
    clientUuid: randomUUID(), product: "kip", buyerId: buyer.id,
    baleIds: balesToSell.map((b) => b.id), soldBy: owner.id,
  });
  assert.equal(kipSale.weightG, 100 * 213_000);
  assert.equal(kipSale.baleCount, 100);
  ok(`${kipSale.baleCount} кип фурӯхта шуд — вазн аз сканер, на аз тарозу`);

  const owedByBuyer = await totalBuyerReceivableD();
  assert.equal(owedByBuyer, kipSale.amountD);
  ok(`харидор ${diramToSomoniString(owedByBuyer)} сомонӣ қарздор шуд`);

  // The one control that matters at the loading bay: a bale cannot leave twice.
  await assert.rejects(
    () => sellProduct({
      clientUuid: randomUUID(), product: "kip", buyerId: buyer.id,
      baleIds: [balesToSell[0]!.id], soldBy: owner.id,
    }),
    (e: Error) => e instanceof DomainError,
    "a bale already on an invoice must not be sold again",
  );
  ok("як кип ду бор фурӯхта намешавад");

  const scanned = await lookupBaleBySerial(balesToSell[0]!.serial);
  assert(scanned?.refusal, "a sold bale must refuse at the scanner, with a reason");
  ok(`сканер сабабро мегӯяд — «${scanned.refusal}»`);

  const stockAfter = await productStock();
  assert.equal(stockAfter.kip.count, 55);
  ok(`дар анбор ${stockAfter.kip.count} кип монд`);
  assert.equal(stockAfter.chigit.weightG, 57_000_000 - 12_000_000);
  ok(`чигити дар анбор — ${gramsToKgString(stockAfter.chigit.weightG, 0)} кг`);

  await assert.rejects(
    () => receiveSalePayment({
      clientUuid: randomUUID(), buyerId: buyer.id,
      amountD: owedByBuyer + 100, receivedBy: cashier.id,
    }),
    (e: Error) => e instanceof DomainError,
    "a receipt larger than the debt must be refused",
  );
  ok("аз қарз зиёдтар пул қабул намешавад");

  const cashBeforeReceipt = await cashOnHandD();
  const receipt = await receiveSalePayment({
    clientUuid: randomUUID(), buyerId: buyer.id,
    amountD: owedByBuyer, receivedBy: cashier.id,
  });
  assert.equal(receipt.balanceAfterD, 0);
  assert.equal(await cashOnHandD(), cashBeforeReceipt + owedByBuyer);
  ok(`расиди ${receipt.receiptNo} — қарзи харидор пӯшида шуд`);

  const [soldBale] = await db
    .select({ state: s.bales.state }).from(s.bales)
    .where(eq(s.bales.id, balesToSell[0]!.id));
  assert.equal(soldBale?.state, "SOLD");
  ok("пас аз пардохт кипҳо «фурӯхта шуд» мешаванд");

  const finalChecks = await runAllChecks(SEASON);
  assert.equal(
    finalChecks.length, 0,
    `integrity checks failed after §7: ${JSON.stringify(finalChecks)}`,
  );
  ok("дафтар пас аз коркард ва фурӯш низ баробар аст");

  console.log(`\n${checks} checks passed against a live database.`);
  console.log(`Нақди дар хазина: ${diramToSomoniString(await cashOnHandD())} сомонӣ\n`);
}

/**
 * Put one truck through the whole intake path: open a borkhat, take брутто, take тара,
 * then sample it in the lab. Nothing is payable until both have happened.
 */
async function newTruck(args: {
  weigher: { id: string }; scale: { id: string };
  farm: { id: string }; batch: { id: string };
  grossKg: number; tareKg: number;
  lab?: { id: string };
  skipLab?: boolean;
  /** Defaults to the seeded 9 % / 2 %. Pass the norms exactly for a zero deduction. */
  moistureBp?: number;
  trashBp?: number;
}): Promise<[string, string]> {
  const ticket = await createTicket({
    clientUuid: randomUUID(),
    season: SEASON,
    stationId: args.scale.id,
    createdBy: args.weigher.id,
    consignorId: args.farm.id,
    batchId: args.batch.id,
  });
  for (const [kind, kg] of [["GROSS", args.grossKg], ["TARE", args.tareKg]] as const) {
    await captureWeight({
      clientUuid: randomUUID(),
      ticketId: ticket.id,
      kind,
      weightG: kg * 1000,
      // The indicator is not wired to a test run, so these say why they were typed.
      source: "manual",
      reason: "тафтиши система",
      operatorId: args.weigher.id,
      stationId: args.scale.id,
    });
  }
  if (!args.skipLab && args.lab) {
    const analysis = await createAnalysis({
      clientUuid: randomUUID(),
      ticketId: ticket.id,
      moistureBp: args.moistureBp ?? 900,
      trashBp: args.trashBp ?? 200,
      labUserId: args.lab.id,
    });
    await approveAnalysis({ analysisId: analysis.id, approverId: args.lab.id });
  }

  return [ticket.id, ticket.serial];
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error("\n", err instanceof DomainError ? err.message : err);
    await sql.end();
    process.exit(1);
  });
