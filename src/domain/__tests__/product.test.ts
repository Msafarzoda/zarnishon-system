import { describe, expect, it } from "vitest";
import { baleSerial, bulkNetG, isBulk, parseBaleSerial, saleAmountD } from "../product";
import { code128Svg, code128bValues } from "@/lib/barcode/code128";
import { DomainError } from "../units";

describe("bale serials", () => {
  it("carries the партия a warehouseman would ask about", () => {
    expect(baleSerial(2026, 101, 42)).toBe("K-2026-101-00042");
  });

  it("round-trips", () => {
    const s = baleSerial(2026, 101, 42);
    expect(parseBaleSerial(s)).toEqual({ season: 2026, batchNumber: 101, n: 42 });
  });

  it("reads a serial typed by hand, in any case and with stray spaces", () => {
    expect(parseBaleSerial(" k-2026-101-00042 ")).toEqual({
      season: 2026, batchNumber: 101, n: 42,
    });
  });

  /*
   * At the loading bay the scanner fires at whatever is in front of it. Anything that is
   * not one of ours has to come back as "not ours", never as an exception — a thrown
   * error there stops the lorry being loaded.
   */
  it("returns null for anything that is not one of our labels", () => {
    for (const junk of ["", "4601234567890", "K-2026-101", "PALLET-7", "К-2026-101-00042"]) {
      expect(parseBaleSerial(junk)).toBeNull();
    }
  });

  it("refuses to number a bale zero", () => {
    expect(() => baleSerial(2026, 101, 0)).toThrow(DomainError);
  });
});

describe("what leaves by the weighbridge", () => {
  it("is everything except кип", () => {
    expect(isBulk("chigit")).toBe(true);
    expect(isBulk("ulyuk")).toBe(true);
    expect(isBulk("puchoq")).toBe(true);
    expect(isBulk("kip")).toBe(false);
  });
});

describe("sale arithmetic", () => {
  it("prices a lorry of чигит by the kilogram", () => {
    // 12 480 kg at 3.20 сомонӣ = 39 936.00
    expect(saleAmountD(12_480_000, 320)).toBe(3_993_600);
  });

  it("rounds half away from zero, like every other amount", () => {
    // 1.5 g at 1 diram/kg = 0.0015 diram, which must not silently truncate to 0
    expect(saleAmountD(1500, 1)).toBe(2);
  });

  it("refuses a lorry that left no heavier than it arrived", () => {
    expect(() => bulkNetG(8_000_000, 8_000_000)).toThrow(DomainError);
    expect(() => bulkNetG(8_000_000, 7_000_000)).toThrow(DomainError);
  });

  it("takes брутто minus тара the way the lorry was actually weighed", () => {
    expect(bulkNetG(8_000_000, 20_480_000)).toBe(12_480_000);
  });
});

describe("code 128", () => {
  /*
   * "CODE128" in set B: start 104, then values 35 47 36 37 17 18 24 weighted 1–7. That
   * sums to 850, and 850 mod 103 is 26. Worked out by hand here on purpose — if the
   * table above is wrong, every label prints a barcode that scans as something else, or
   * as nothing, and nobody finds out until the lorry is half loaded.
   */
  it("computes the check character by the published weighting", () => {
    const values = code128bValues("CODE128");
    expect(values[0]).toBe(104);
    expect(values.slice(1, -2)).toEqual([35, 47, 36, 37, 17, 18, 24]);
    expect(values[values.length - 2]).toBe(26);
    expect(values[values.length - 1]).toBe(106);
  });

  it("encodes a bale serial as start, data, check and stop", () => {
    const serial = baleSerial(2026, 101, 42);
    const values = code128bValues(serial);
    expect(values.length).toBe(serial.length + 3);
  });

  it("renders bars a scanner can see, quiet zones included", () => {
    const svg = code128Svg("K-2026-101-00042");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<rect");
    // The first bar starts after the quiet zone, never at x=0.
    expect(svg).not.toContain('<rect x="0"');
  });

  it("refuses what set B cannot carry, rather than printing a wrong label", () => {
    expect(() => code128bValues("КИП")).toThrow();
  });
});
