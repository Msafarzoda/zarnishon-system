import { describe, expect, it } from "vitest";
import { DomainError } from "../units";
import { settleTicket } from "../settlement";
import {
  type DraftEntry,
  assertBalanced,
  balanceOf,
  buildAdvanceIssuedTx,
  buildAdvanceRepaidCashTx,
  buildCottonPaymentTx,
  buildReversalTx,
  buildSeedSaleReceiptTx,
} from "../ledger";

const ACC = {
  cashAccountId: "cash",
  cottonPurchaseAccountId: "cotton",
  advanceAccountId: "advance-bilol",
  seedRevenueAccountId: "seed",
};

describe("assertBalanced", () => {
  it("rejects a transaction that does not sum to zero", () => {
    expect(() =>
      assertBalanced({
        kind: "CASH_ADJUSTMENT",
        memo: "bad",
        entries: [
          { accountId: "a", amountD: 100 },
          { accountId: "b", amountD: -99 },
        ],
      }),
    ).toThrow(/does not balance/);
  });

  it("rejects zero-amount and single-sided entries", () => {
    expect(() =>
      assertBalanced({ kind: "CASH_ADJUSTMENT", memo: "x", entries: [{ accountId: "a", amountD: 0 }] }),
    ).toThrow(DomainError);
  });
});

describe("cotton payment posting", () => {
  const settlement = settleTicket({
    netG: 635_000,
    deductionBp: 100,
    priceDPerKg: 1250,
    outstandingAdvanceD: 0,
  });

  it("debits the purchase and credits only the cash actually handed over", () => {
    const tx = buildCottonPaymentTx(settlement, ACC, "Борхат T1-2026-000046");
    expect(balanceOf(tx.entries, "cotton")).toBe(785_813);
    expect(balanceOf(tx.entries, "cash")).toBe(-785_813);
    expect(tx.entries).toHaveLength(2);
  });

  it("splits the credit when an advance is recovered", () => {
    const withAdvance = settleTicket({
      netG: 635_000,
      deductionBp: 100,
      priceDPerKg: 1250,
      outstandingAdvanceD: 300_000,
    });
    const tx = buildCottonPaymentTx(withAdvance, ACC, "Борхат T1-2026-000046");
    expect(balanceOf(tx.entries, "cotton")).toBe(785_813);
    expect(balanceOf(tx.entries, "cash")).toBe(-485_813);
    expect(balanceOf(tx.entries, "advance-bilol")).toBe(-300_000);
  });

  it("emits no cash entry at all when the advance swallows the whole ticket", () => {
    const swallowed = settleTicket({
      netG: 635_000,
      deductionBp: 100,
      priceDPerKg: 1250,
      outstandingAdvanceD: 1_000_000,
    });
    const tx = buildCottonPaymentTx(swallowed, ACC, "full offset");
    expect(tx.entries.map((e) => e.accountId).sort()).toEqual(["advance-bilol", "cotton"]);
    expect(balanceOf(tx.entries, "cash")).toBe(0);
  });

  it("refuses to recover an advance without a farm advance account", () => {
    const withAdvance = settleTicket({
      netG: 635_000,
      deductionBp: 100,
      priceDPerKg: 1250,
      outstandingAdvanceD: 300_000,
    });
    expect(() =>
      buildCottonPaymentTx(
        withAdvance,
        { cashAccountId: "cash", cottonPurchaseAccountId: "cotton" },
        "no advance account",
      ),
    ).toThrow(/no advance account/);
  });

  it("refuses a settlement whose parts do not add up", () => {
    expect(() =>
      buildCottonPaymentTx(
        { ...settlement, cashPayableD: settlement.cashPayableD + 1 },
        ACC,
        "tampered",
      ),
    ).toThrow(/internally inconsistent/);
  });
});

describe("advances and seed sales", () => {
  it("moves cash out of the drawer and onto the farm's account", () => {
    const tx = buildAdvanceIssuedTx(500_000, ACC, "Қарз барои чиниши пахта");
    expect(balanceOf(tx.entries, "advance-bilol")).toBe(500_000);
    expect(balanceOf(tx.entries, "cash")).toBe(-500_000);
  });

  it("records a cash repayment in the opposite direction", () => {
    const tx = buildAdvanceRepaidCashTx(200_000, ACC, "repayment");
    expect(balanceOf(tx.entries, "cash")).toBe(200_000);
    expect(balanceOf(tx.entries, "advance-bilol")).toBe(-200_000);
  });

  it("puts seed money into the same drawer the factory pays farmers from", () => {
    const tx = buildSeedSaleReceiptTx(4_000_000, ACC, "Фурӯши тухмӣ");
    expect(balanceOf(tx.entries, "cash")).toBe(4_000_000);
    expect(balanceOf(tx.entries, "seed")).toBe(-4_000_000);
  });

  it("rejects zero-value movements", () => {
    expect(() => buildAdvanceIssuedTx(0, ACC, "x")).toThrow(DomainError);
    expect(() => buildSeedSaleReceiptTx(0, ACC, "x")).toThrow(DomainError);
  });
});

describe("reversal", () => {
  it("mirrors every entry and demands a reason", () => {
    const original = buildAdvanceIssuedTx(500_000, ACC, "Қарз");
    const reversal = buildReversalTx(original, "хатои хазинадор");
    expect(balanceOf(reversal.entries, "advance-bilol")).toBe(-500_000);
    expect(balanceOf(reversal.entries, "cash")).toBe(500_000);
    expect(reversal.memo).toContain("хатои хазинадор");
    expect(() => buildReversalTx(original, "   ")).toThrow(/requires a reason/);
  });

  it("leaves every account flat once original and reversal are both posted", () => {
    const original = buildAdvanceIssuedTx(500_000, ACC, "Қарз");
    const reversal = buildReversalTx(original, "duplicate entry");
    const all: DraftEntry[] = [...original.entries, ...reversal.entries];
    for (const account of ["cash", "advance-bilol"]) {
      expect(balanceOf(all, account)).toBe(0);
    }
  });
});

describe("cash on hand is always derived", () => {
  it("tracks a full day at the cash desk", () => {
    const entries: DraftEntry[] = [];
    // open the drawer with 20 000 сомонӣ
    entries.push(
      ...assertBalanced({
        kind: "CASH_OPENING",
        memo: "Оғози рӯз",
        entries: [
          { accountId: "cash", amountD: 2_000_000 },
          { accountId: "opening", amountD: -2_000_000 },
        ],
      }).entries,
    );
    // lend a farm 5 000
    entries.push(...buildAdvanceIssuedTx(500_000, ACC, "Қарз").entries);
    // sell seed for 40 000
    entries.push(...buildSeedSaleReceiptTx(4_000_000, ACC, "Фурӯши тухмӣ").entries);
    // pay ticket №46, recovering 3 000 of the advance
    const s = settleTicket({
      netG: 635_000,
      deductionBp: 100,
      priceDPerKg: 1250,
      outstandingAdvanceD: 300_000,
    });
    entries.push(...buildCottonPaymentTx(s, ACC, "Борхат №46").entries);

    // 2 000 000 − 500 000 + 4 000 000 − 485 813
    expect(balanceOf(entries, "cash")).toBe(5_014_187);
    // the farm took 5 000, 3 000 came back as cotton -> 2 000 still outstanding
    expect(balanceOf(entries, "advance-bilol")).toBe(200_000);
    // and the books as a whole are flat
    expect(entries.reduce((n, e) => n + e.amountD, 0)).toBe(0);
  });
});
