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
import { issueAdvance } from "../src/server/services/advances";
import { captureWeight, createTicket } from "../src/server/services/tickets";
import { cashOnHandD, outstandingAdvanceD } from "../src/server/services/balances";
import { runAllChecks } from "../src/server/services/integrity";
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
  const [weigher] = await db.select().from(s.users).where(eq(s.users.username, "salimov"));
  const [scale] = await db.select().from(s.stations).where(eq(s.stations.code, "T1"));
  const [farm] = await db.select().from(s.counterparties).where(eq(s.counterparties.tin, "5830076707"));
  const [batch] = await db
    .select().from(s.batches)
    .where(and(eq(s.batches.season, SEASON), eq(s.batches.number, 101)));
  assert(cashier && labTech && weigher && scale && farm && batch, "seed data missing — run db:seed");

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
  assert.equal(settled.grossAmountD, 785_813);
  assert.equal(settled.advanceOffsetD, 300_000);
  assert.equal(settled.cashPayableD, 485_813);
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
      operatorId: args.weigher.id,
      stationId: args.scale.id,
    });
  }
  if (!args.skipLab && args.lab) {
    const analysis = await createAnalysis({
      clientUuid: randomUUID(),
      ticketId: ticket.id,
      moistureBp: 900,
      trashBp: 200,
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
