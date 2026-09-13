import { describe, expect, it } from "vitest";
import { DomainError } from "../units.js";
import { TICKET_STATUSES, canTransition, transition } from "../ticket.js";

describe("ticket lifecycle", () => {
  it("walks the happy path from draft to paid", () => {
    let s = transition("DRAFT", "CAPTURE_GROSS");
    expect(s).toBe("OPEN");
    s = transition(s, "CAPTURE_TARE");
    expect(s).toBe("WEIGHED");
    s = transition(s, "APPROVE_ANALYSIS");
    expect(s).toBe("ANALYSED");
    s = transition(s, "PAY");
    expect(s).toBe("PAID");
  });

  /** The paper control — no ticket, no second payment — enforced in code too. */
  it("refuses to pay the same ticket twice, in the operator's language", () => {
    expect(() => transition("PAID", "PAY")).toThrow(/аллакай пардохт шудааст/);
    expect(() => transition("PAID", "PAY")).toThrow(DomainError);
  });

  it("refuses to pay before the lab has approved the batch", () => {
    expect(() => transition("WEIGHED", "PAY")).toThrow(/лаборатория тасдиқ нашудааст/);
  });

  it("refuses to pay a voided ticket", () => {
    expect(() => transition("VOID", "PAY")).toThrow(/бекор карда шудааст/);
  });

  it("refuses to take a tare before a gross", () => {
    expect(() => transition("DRAFT", "CAPTURE_TARE")).toThrow(DomainError);
  });

  it("allows voiding anything that is not already terminal", () => {
    expect(canTransition("DRAFT", "VOID")).toBe(true);
    expect(canTransition("OPEN", "VOID")).toBe(true);
    expect(canTransition("WEIGHED", "VOID")).toBe(true);
    expect(canTransition("ANALYSED", "VOID")).toBe(true);
    expect(canTransition("PAID", "VOID")).toBe(false);
    expect(canTransition("VOID", "VOID")).toBe(false);
  });

  it("leaves no status without a defined answer for every transition", () => {
    for (const from of TICKET_STATUSES) {
      for (const t of ["CAPTURE_GROSS", "CAPTURE_TARE", "APPROVE_ANALYSIS", "PAY", "VOID"] as const) {
        expect(typeof canTransition(from, t)).toBe("boolean");
      }
    }
  });
});
