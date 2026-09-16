import { describe, expect, it } from "vitest";
import { DomainError, diramToSomoniString, gramsToKgString } from "../units";
import { deductionBp, netWeight, payableWeight } from "../weight";
import { settleTicket } from "../settlement";

/**
 * The real paperwork this system replaces:
 *   Борхат №46, Партия 101, х-д Намуна (РЯМ 0000000001), Газел, Ронанда
 *   Брутто 3015 kg / Тара 2380 kg / Нетто 635 kg
 *   Форма №9-хл, партия 101: влажность 9 %, засорённость 2 %
 */
const TICKET_46 = { grossG: 3_015_000, tareG: 2_380_000 };
const BATCH_101_LAB = { moistureBp: 900, trashBp: 200 };
const NORMS = { moistureBp: 800, trashBp: 200 };

describe("netWeight — Брутто − Тара", () => {
  it("reproduces ticket №46 exactly", () => {
    const net = netWeight(TICKET_46.grossG, TICKET_46.tareG);
    expect(net).toBe(635_000);
    expect(gramsToKgString(net, 0)).toBe("635");
  });

  it("refuses a tare at or above gross — the two weighings were swapped", () => {
    expect(() => netWeight(2_380_000, 3_015_000)).toThrow(DomainError);
    expect(() => netWeight(3_015_000, 3_015_000)).toThrow(/less than gross/);
  });

  it("refuses negative or fractional grams", () => {
    expect(() => netWeight(-1, 0)).toThrow(DomainError);
    expect(() => netWeight(1000.5, 10)).toThrow(DomainError);
  });
});

describe("deductionBp — the two modes give materially different answers", () => {
  it("TOTAL deducts the full measured moisture and trash", () => {
    expect(deductionBp(BATCH_101_LAB, "TOTAL", NORMS)).toBe(1100); // 11 %
  });

  it("EXCESS_OVER_NORM deducts only what exceeds the contract norms", () => {
    expect(deductionBp(BATCH_101_LAB, "EXCESS_OVER_NORM", NORMS)).toBe(100); // 1 %
  });

  it("EXCESS_OVER_NORM never produces a credit for cotton better than norm", () => {
    const dry = { moistureBp: 500, trashBp: 50 };
    expect(deductionBp(dry, "EXCESS_OVER_NORM", NORMS)).toBe(0);
  });

  it("refuses an analysis that would leave nothing payable", () => {
    expect(() => deductionBp({ moistureBp: 6000, trashBp: 4000 }, "TOTAL", NORMS)).toThrow(
      DomainError,
    );
  });

  /** This is the difference the owner is deciding on. docs/domain.md §3. */
  it("on ticket №46 the mode is worth 63.5 kg of payable cotton", () => {
    const net = netWeight(TICKET_46.grossG, TICKET_46.tareG);
    const total = payableWeight(net, deductionBp(BATCH_101_LAB, "TOTAL", NORMS));
    const excess = payableWeight(net, deductionBp(BATCH_101_LAB, "EXCESS_OVER_NORM", NORMS));
    expect(gramsToKgString(total, 2)).toBe("565.15");
    expect(gramsToKgString(excess, 2)).toBe("628.65");
    expect(excess - total).toBe(63_500);
  });
});

describe("payableWeight", () => {
  it("matches the owner's worked example: 95 kg at 1.5 % -> 93.575 kg", () => {
    expect(payableWeight(95_000, 150)).toBe(93_575);
  });

  it("is the identity when there is nothing to deduct", () => {
    expect(payableWeight(635_000, 0)).toBe(635_000);
  });

  it("rounds half away from zero at the gram", () => {
    // 1 g at 0.5 % -> 0.995 g -> 1 g
    expect(payableWeight(1, 50)).toBe(1);
    // 3 g at 50 % -> 1.5 g -> 2 g
    expect(payableWeight(3, 5000)).toBe(2);
  });

  it("refuses a 100 % deduction", () => {
    expect(() => payableWeight(635_000, 10_000)).toThrow(DomainError);
  });
});

describe("settleTicket", () => {
  const base = {
    netG: 635_000,
    deductionBp: 100,
    priceDPerKg: 1250, // 12.50 сомонӣ/кг
    outstandingAdvanceD: 0,
  };

  it("settles ticket №46 with no advance", () => {
    const s = settleTicket(base);
    expect(gramsToKgString(s.payableG, 2)).toBe("628.65");
    // 628.65 kg × 12.50 = 7 858.125 -> 7 858.13
    expect(s.grossAmountD).toBe(785_813);
    expect(diramToSomoniString(s.grossAmountD)).toBe("7 858.13");
    expect(s.advanceOffsetD).toBe(0);
    expect(s.cashPayableD).toBe(785_813);
    expect(s.remainingAdvanceD).toBe(0);
  });

  it("recovers an advance before handing over cash", () => {
    const s = settleTicket({ ...base, outstandingAdvanceD: 300_000 }); // 3 000 сомонӣ
    expect(s.advanceOffsetD).toBe(300_000);
    expect(s.cashPayableD).toBe(485_813);
    expect(s.remainingAdvanceD).toBe(0);
  });

  it("never pays out negative cash when the advance exceeds the ticket", () => {
    const s = settleTicket({ ...base, outstandingAdvanceD: 1_000_000 });
    expect(s.cashPayableD).toBe(0);
    expect(s.advanceOffsetD).toBe(785_813);
    expect(s.remainingAdvanceD).toBe(214_187);
    // the farm still owes the difference against its next delivery
    expect(s.advanceOffsetD + s.remainingAdvanceD).toBe(1_000_000);
  });

  it("keeps the books balanced: gross = cash + advance recovered", () => {
    for (const advance of [0, 1, 100_000, 785_812, 785_813, 785_814, 5_000_000]) {
      const s = settleTicket({ ...base, outstandingAdvanceD: advance });
      expect(s.cashPayableD + s.advanceOffsetD).toBe(s.grossAmountD);
      expect(s.cashPayableD).toBeGreaterThanOrEqual(0);
      expect(s.remainingAdvanceD).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the price handed to it — the caller supplies the price of the payment day", () => {
    const later = settleTicket({ ...base, priceDPerKg: 1400 });
    expect(later.grossAmountD).toBe(880_110); // 628.65 × 14.00 = 8 801.10
    expect(later.grossAmountD).toBeGreaterThan(settleTicket(base).grossAmountD);
  });

  it("rejects impossible inputs instead of producing a number", () => {
    expect(() => settleTicket({ ...base, netG: -1 })).toThrow(DomainError);
    expect(() => settleTicket({ ...base, priceDPerKg: -1 })).toThrow(DomainError);
    expect(() => settleTicket({ ...base, outstandingAdvanceD: -1 })).toThrow(DomainError);
  });
});
