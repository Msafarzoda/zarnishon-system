import { describe, expect, it } from "vitest";
import {
  DomainError,
  bpToPercentString,
  diramToSomoniString,
  divRound,
  gramsToKgString,
  kgStringToGrams,
  percentStringToBp,
  somoniStringToDiram,
} from "../units";

describe("divRound", () => {
  it("rounds half away from zero", () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 2)).toBe(2);
    expect(divRound(1, 3)).toBe(0);
    expect(divRound(2, 3)).toBe(1);
  });

  it("rejects a non-positive denominator", () => {
    expect(() => divRound(1, 0)).toThrow(DomainError);
    expect(() => divRound(1, -2)).toThrow(DomainError);
  });
});

describe("kilogram parsing", () => {
  it("parses whole and fractional kilograms from operator input", () => {
    expect(kgStringToGrams("3015")).toBe(3_015_000);
    expect(kgStringToGrams("2380")).toBe(2_380_000);
    expect(kgStringToGrams("635.5")).toBe(635_500);
    expect(kgStringToGrams("0.001")).toBe(1);
  });

  it("accepts a comma as the decimal separator, as typed on a Cyrillic keyboard", () => {
    expect(kgStringToGrams("635,25")).toBe(635_250);
  });

  it("rejects junk rather than silently reading zero", () => {
    for (const bad of ["", "abc", "-5", "1.2345", "1 000", "1e3"]) {
      expect(() => kgStringToGrams(bad), bad).toThrow(DomainError);
    }
  });

  it("round-trips through the display form", () => {
    expect(gramsToKgString(635_000)).toBe("635.000");
    expect(gramsToKgString(3_015_000, 1)).toBe("3015.0");
    expect(gramsToKgString(1)).toBe("0.001");
  });

  /** The farmer reads this number off his printed Борхат — it must not round against him. */
  it("rounds to the displayed digit instead of truncating", () => {
    expect(gramsToKgString(628_650, 1)).toBe("628.7");
    expect(gramsToKgString(628_650, 2)).toBe("628.65");
    expect(gramsToKgString(1_138_500, 0)).toBe("1139");
    expect(gramsToKgString(1_138_400, 0)).toBe("1138");
    expect(gramsToKgString(999_500, 0)).toBe("1000");
    expect(gramsToKgString(-628_650, 1)).toBe("-628.7");
  });

  it("clamps the requested precision to what a gram can express", () => {
    expect(gramsToKgString(635_123, 9)).toBe("635.123");
    expect(gramsToKgString(635_500, -2)).toBe("636");
  });
});

describe("money parsing", () => {
  it("parses somoni to diram", () => {
    expect(somoniStringToDiram("12.50")).toBe(1250);
    expect(somoniStringToDiram("12,5")).toBe(1250);
    expect(somoniStringToDiram("0.01")).toBe(1);
    expect(somoniStringToDiram("1000")).toBe(100_000);
  });

  it("formats diram for display with thousands separators", () => {
    expect(diramToSomoniString(785_813)).toBe("7 858.13");
    expect(diramToSomoniString(1250)).toBe("12.50");
    expect(diramToSomoniString(-500)).toBe("-5.00");
  });
});

describe("percent parsing", () => {
  it("parses percent to basis points", () => {
    expect(percentStringToBp("1.5")).toBe(150);
    expect(percentStringToBp("9")).toBe(900);
    expect(percentStringToBp("2")).toBe(200);
    expect(percentStringToBp("0.25")).toBe(25);
  });

  it("refuses a percentage above 100", () => {
    expect(() => percentStringToBp("101")).toThrow(DomainError);
  });

  it("formats basis points back to percent", () => {
    expect(bpToPercentString(150)).toBe("1.50");
    expect(bpToPercentString(900)).toBe("9.00");
  });
});

describe("somoni typed the way it is displayed", () => {
  it("accepts the grouped form that diramToSomoniString produces", () => {
    // The cash desk pre-fills an amount field from a displayed balance; rejecting its own
    // output left the cashier with a correct figure on screen and a refusal under it.
    const displayed = diramToSomoniString(19_224_313);
    // Grouped with a non-breaking space — good typography, and the exact reason the
    // parser could not read the formatter's own output.
    expect(displayed).toBe("192\u00a0243.13");
    expect(somoniStringToDiram(displayed)).toBe(19_224_313);
  });

  it("accepts a non-breaking or narrow space as a group separator", () => {
    expect(somoniStringToDiram("2 000.50")).toBe(200_050);
    expect(somoniStringToDiram("2 000,50")).toBe(200_050);
  });

  it("still refuses anything that is not a number", () => {
    expect(() => somoniStringToDiram("2 000 сомонӣ")).toThrow(DomainError);
    expect(() => somoniStringToDiram("-100")).toThrow(DomainError);
    expect(() => somoniStringToDiram("")).toThrow(DomainError);
  });
});
