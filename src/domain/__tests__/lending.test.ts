import { describe, expect, it } from "vitest";
import { collateralFor } from "../lending";
import { planFarmSettlement, type SettlementCandidate } from "../farm-settlement";

describe("the lending limit is cotton in hand", () => {
  const RATE = 100; // 1 сомонӣ per kg

  it("lends 1 сомонӣ per kg of cotton in the shed", () => {
    // The owner's own example: 3 000 kg in hand means up to 3 000 сомонӣ.
    const c = collateralFor({
      cottonInHandG: 3_000_000,
      outstandingAdvanceD: 0,
      advanceRateDPerKg: RATE,
    });
    expect(c.maxAdvanceD).toBe(300_000);
    expect(c.headroomD).toBe(300_000);
    expect(c.overLent).toBe(false);
  });

  it("counts what is already borrowed against the limit", () => {
    const c = collateralFor({
      cottonInHandG: 3_000_000,
      outstandingAdvanceD: 200_000,
      advanceRateDPerKg: RATE,
    });
    expect(c.headroomD).toBe(100_000);
  });

  it("lends nothing to a farm with no cotton in hand", () => {
    const c = collateralFor({
      cottonInHandG: 0, outstandingAdvanceD: 0, advanceRateDPerKg: RATE,
    });
    expect(c.maxAdvanceD).toBe(0);
    expect(c.headroomD).toBe(0);
  });

  it("never offers negative headroom once the cotton has been settled away", () => {
    // Cotton leaves the collateral pool when it is settled; the loan does not follow it.
    const c = collateralFor({
      cottonInHandG: 500_000, outstandingAdvanceD: 300_000, advanceRateDPerKg: RATE,
    });
    expect(c.headroomD).toBe(0);
    expect(c.overLent).toBe(true);
  });

  it("applies no lab deduction — the cap is on raw нетто", () => {
    // 3 000 kg at 9 % moisture would be ~2 970 kg payable. The cap ignores that.
    const c = collateralFor({
      cottonInHandG: 3_000_000, outstandingAdvanceD: 0, advanceRateDPerKg: RATE,
    });
    expect(c.maxAdvanceD).toBe(300_000);
  });

  it("follows the owner's rate when it changes", () => {
    const c = collateralFor({
      cottonInHandG: 3_000_000, outstandingAdvanceD: 0, advanceRateDPerKg: 250,
    });
    expect(c.maxAdvanceD).toBe(750_000); // 2.50 сомонӣ per kg
  });
});

describe("settling enough борхатҳо to cover what a farm asks for", () => {
  // The owner's example: 5 t, then 10 t, then 5 t — 20 t in hand.
  // No deduction and 6.00 сомонӣ/kg, so the arithmetic reads straight off the weights.
  const PRICE = 600;
  const candidates: SettlementCandidate[] = [
    { ticketId: "a", serial: "T1-000001", weighedAt: 1, netG: 5_000_000, deductionBp: 0, priceDPerKg: PRICE },
    { ticketId: "b", serial: "T1-000002", weighedAt: 2, netG: 10_000_000, deductionBp: 0, priceDPerKg: PRICE },
    { ticketId: "c", serial: "T1-000003", weighedAt: 3, netG: 5_000_000, deductionBp: 0, priceDPerKg: PRICE },
  ];

  it("takes the oldest борхат first and stops as soon as it covers the amount", () => {
    // 6 000 сомонӣ asked for; the first ticket alone is worth 30 000.
    const p = planFarmSettlement({
      candidates, requestedCashD: 600_000, outstandingAdvanceD: 0,
    });
    expect(p.tickets.map((t) => t.serial)).toEqual(["T1-000001"]);
    expect(p.cashPayableD).toBe(3_000_000);
    expect(p.disburseD).toBe(600_000);
    // A борхат cannot be split, so the rest of it stays on the farm's balance.
    expect(p.remainderD).toBe(2_400_000);
    expect(p.shortfallD).toBe(0);
  });

  it("takes further борхатҳо only when one does not cover it", () => {
    const p = planFarmSettlement({
      candidates, requestedCashD: 3_500_000, outstandingAdvanceD: 0,
    });
    expect(p.tickets.map((t) => t.serial)).toEqual(["T1-000001", "T1-000002"]);
    expect(p.cashPayableD).toBe(9_000_000);
    expect(p.disburseD).toBe(3_500_000);
  });

  it("recovers the outstanding advance before any cash is owed", () => {
    const p = planFarmSettlement({
      candidates, requestedCashD: 600_000, outstandingAdvanceD: 500_000,
    });
    expect(p.advanceOffsetD).toBe(500_000);
    expect(p.cashPayableD).toBe(2_500_000); // 30 000 − 5 000
    expect(p.advanceRemainingD).toBe(0);
  });

  it("keeps taking tickets while the advance is swallowing them whole", () => {
    // An advance bigger than the first ticket: the first hands over nothing, so the plan
    // must go on rather than stopping at a cash payable of zero.
    const p = planFarmSettlement({
      candidates, requestedCashD: 100_000, outstandingAdvanceD: 3_500_000,
    });
    expect(p.tickets.map((t) => t.serial)).toEqual(["T1-000001", "T1-000002"]);
    expect(p.advanceOffsetD).toBe(3_500_000);
    expect(p.disburseD).toBe(100_000);
  });

  it("says how far short it falls when everything in hand is not enough", () => {
    const p = planFarmSettlement({
      candidates, requestedCashD: 20_000_000, outstandingAdvanceD: 0,
    });
    expect(p.tickets).toHaveLength(3);
    expect(p.cashPayableD).toBe(12_000_000); // 20 t × 6.00
    expect(p.disburseD).toBe(12_000_000);
    expect(p.shortfallD).toBe(8_000_000);
  });

  it("settles everything in hand when no amount is named", () => {
    const p = planFarmSettlement({
      candidates, requestedCashD: null, outstandingAdvanceD: 0,
    });
    expect(p.tickets).toHaveLength(3);
    expect(p.disburseD).toBe(12_000_000);
    expect(p.remainderD).toBe(0);
  });

  it("settles nothing when there is nothing in hand", () => {
    const p = planFarmSettlement({
      candidates: [], requestedCashD: 600_000, outstandingAdvanceD: 0,
    });
    expect(p.tickets).toHaveLength(0);
    expect(p.disburseD).toBe(0);
    expect(p.shortfallD).toBe(600_000);
  });

  it("prices each ticket by its own variety, not by one headline price", () => {
    const mixed: SettlementCandidate[] = [
      { ...candidates[0]!, priceDPerKg: 600 },
      { ...candidates[1]!, priceDPerKg: 550 },
    ];
    const p = planFarmSettlement({
      candidates: mixed, requestedCashD: null, outstandingAdvanceD: 0,
    });
    expect(p.tickets[0]!.grossAmountD).toBe(3_000_000);
    expect(p.tickets[1]!.grossAmountD).toBe(5_500_000);
  });
});

describe("money already owed is spent before any cotton is sold", () => {
  const PRICE = 600;
  const candidates: SettlementCandidate[] = [
    { ticketId: "a", serial: "T1-000001", weighedAt: 1, netG: 10_000_000, deductionBp: 0, priceDPerKg: PRICE },
    { ticketId: "b", serial: "T1-000002", weighedAt: 2, netG: 5_000_000, deductionBp: 0, priceDPerKg: PRICE },
  ];

  it("settles nothing when the farm's balance already covers the request", () => {
    // 24 000 сомонӣ on account, 6 000 asked for: this is a collection, not a sale.
    // Settling a борхат anyway would lock today's price onto ten tonnes for nothing.
    const p = planFarmSettlement({
      candidates, requestedCashD: 600_000,
      outstandingAdvanceD: 0, existingBalanceD: 2_400_000,
    });
    expect(p.tickets).toHaveLength(0);
    expect(p.fromBalanceD).toBe(600_000);
    expect(p.disburseD).toBe(600_000);
    expect(p.remainderD).toBe(1_800_000);
    expect(p.shortfallD).toBe(0);
  });

  it("sells only what the balance cannot cover", () => {
    // 2 000 on account, 8 000 asked for: 6 000 short, so one борхат is settled.
    const p = planFarmSettlement({
      candidates, requestedCashD: 800_000,
      outstandingAdvanceD: 0, existingBalanceD: 200_000,
    });
    expect(p.tickets.map((t) => t.serial)).toEqual(["T1-000001"]);
    expect(p.fromBalanceD).toBe(200_000);
    expect(p.disburseD).toBe(800_000);
    // 6 000 000 settled + 0 left of the balance − 800 000 handed over
    expect(p.remainderD).toBe(5_400_000);
  });

  it("counts the balance towards covering a request it cannot meet on cotton alone", () => {
    const p = planFarmSettlement({
      candidates: [], requestedCashD: 800_000,
      outstandingAdvanceD: 0, existingBalanceD: 200_000,
    });
    expect(p.disburseD).toBe(200_000);
    expect(p.shortfallD).toBe(600_000);
  });

  it("still sells the lot when asked to settle everything", () => {
    // "Ҳамаи пахтаи омода" is an instruction to sell, not a request for an amount.
    const p = planFarmSettlement({
      candidates, requestedCashD: null,
      outstandingAdvanceD: 0, existingBalanceD: 200_000,
    });
    expect(p.tickets).toHaveLength(2);
    expect(p.disburseD).toBe(9_200_000); // 90 000 of cotton + the 2 000 on account
    expect(p.remainderD).toBe(0);
  });

  it("behaves as before for a farm with no balance", () => {
    const p = planFarmSettlement({
      candidates, requestedCashD: 600_000, outstandingAdvanceD: 0,
    });
    expect(p.fromBalanceD).toBe(0);
    expect(p.tickets.map((t) => t.serial)).toEqual(["T1-000001"]);
  });
});
