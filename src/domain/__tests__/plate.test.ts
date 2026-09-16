import { describe, expect, it } from "vitest";
import { DomainError } from "../units";
import { normalisePlate, normaliseTin, isPlausibleTin } from "../plate";

describe("normalisePlate", () => {
  it("accepts the four-digit form", () => {
    expect(normalisePlate("1234 AB 01")).toEqual({ plate: "1234 AB 01", standard: true });
  });

  it("accepts the unspaced three-digit form", () => {
    expect(normalisePlate("123AB01")).toEqual({ plate: "123 AB 01", standard: true });
  });

  it("collapses whatever separators and case the operator typed", () => {
    for (const typed of ["1234AB01", "1234 ab 01", "1234-AB-01", "  1234  Ab  01 "]) {
      expect(normalisePlate(typed).plate, typed).toBe("1234 AB 01");
    }
  });

  /**
   * The reason this module exists: on a Cyrillic keyboard these letters are identical
   * on screen and different bytes. Without folding, the same truck gets two records.
   */
  it("folds Cyrillic letters onto their identical Latin twins", () => {
    expect(normalisePlate("1234 АВ 01").plate).toBe("1234 AB 01"); // Cyrillic А, В
    expect(normalisePlate("5678 КМ 02").plate).toBe("5678 KM 02"); // Cyrillic К, М
    expect(normalisePlate("9012 РС 03").plate).toBe("9012 PC 03"); // Cyrillic Р, С
    expect(normalisePlate("3456 ТХ 04").plate).toBe("3456 TX 04"); // Cyrillic Т, Х
  });

  it("gives a Cyrillic-typed and a Latin-typed plate the same key", () => {
    expect(normalisePlate("1234 АВ 01").plate).toBe(normalisePlate("1234 AB 01").plate);
    expect(normalisePlate("1234АВ01").plate).toBe(normalisePlate("1234ab01").plate);
  });

  /** A trailer or a foreign truck must never stop the weighbridge. */
  it("keeps an unrecognised plate instead of refusing it, but flags it", () => {
    const odd = normalisePlate("22-60");
    expect(odd.standard).toBe(false);
    expect(odd.plate).toBe("22-60");

    const foreign = normalisePlate("KZ 777 XYZ");
    expect(foreign.standard).toBe(false);
  });

  it("refuses an empty plate", () => {
    expect(() => normalisePlate("   ")).toThrow(DomainError);
  });
});

describe("РМА — the farm's identity", () => {
  it("keeps only the digits, however it was written", () => {
    expect(normaliseTin("5830076707")).toBe("5830076707");
    expect(normaliseTin("583 007 6707")).toBe("5830076707");
    expect(normaliseTin("583-007-6707")).toBe("5830076707");
    expect(normaliseTin("РМА 5830076707")).toBe("5830076707");
  });

  it("treats the same number written three ways as one farm", () => {
    const written = ["5830076707", "583 007 6707", "РМА: 583-007-6707"];
    expect(new Set(written.map(normaliseTin)).size).toBe(1);
  });

  it("accepts a real number and rejects a placeholder", () => {
    expect(isPlausibleTin("5830076707")).toBe(true);
    expect(isPlausibleTin("000000000")).toBe(false);
    expect(isPlausibleTin("123")).toBe(false);
    expect(isPlausibleTin("")).toBe(false);
  });
});
