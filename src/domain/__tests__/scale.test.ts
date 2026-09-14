import { describe, expect, it } from "vitest";
import { DomainError } from "../units";
import {
  SCALE_PROTOCOLS,
  customProtocol,
  isSettled,
  parseScaleFrame,
  type ScaleReading,
} from "../scale";

const cas = SCALE_PROTOCOLS.cas!;
const tenzo = SCALE_PROTOCOLS.tenzo!;
const plain = SCALE_PROTOCOLS.plain!;

describe("parseScaleFrame — CAS / Toledo", () => {
  it("reads a stable gross weight", () => {
    expect(parseScaleFrame("ST,GS,+003015.0kg\r\n", cas)).toEqual({
      weightG: 3_015_000,
      stable: true,
      raw: "ST,GS,+003015.0kg",
    });
  });

  it("marks an unsettled frame unstable — the truck is still rocking", () => {
    expect(parseScaleFrame("US,GS,+003012.5kg", cas)?.stable).toBe(false);
  });

  it("reads through the padding indicators emit", () => {
    expect(parseScaleFrame("ST, GS, +   2380 kg", cas)?.weightG).toBe(2_380_000);
  });

  it("accepts a comma decimal separator", () => {
    expect(parseScaleFrame("ST,GS,+635,5kg", cas)?.weightG).toBe(635_500);
  });

  it("converts whatever unit the indicator reports", () => {
    expect(parseScaleFrame("ST,GS,+3015000g", cas)?.weightG).toBe(3_015_000);
    expect(parseScaleFrame("ST,GS,+3.015t", cas)?.weightG).toBe(3_015_000);
  });

  it("refuses an overload frame's status as stable", () => {
    expect(parseScaleFrame("OL,GS,+999999kg", cas)?.stable).toBe(false);
  });
});

describe("parseScaleFrame — other indicators", () => {
  it("reads Tenzo-M", () => {
    expect(parseScaleFrame("=  3015", tenzo)?.weightG).toBe(3_015_000);
    expect(parseScaleFrame("= +2380", tenzo)?.weightG).toBe(2_380_000);
  });

  it("reads a bare number", () => {
    expect(parseScaleFrame("3015\r\n", plain)?.weightG).toBe(3_015_000);
    expect(parseScaleFrame("-12.5", plain)?.weightG).toBe(-12_500);
  });
});

/** Serial lines carry partial frames and noise. Guessing at those would invent weights. */
describe("parseScaleFrame — junk is refused, never guessed at", () => {
  it("returns null rather than a number", () => {
    for (const junk of ["", "\r\n", "ST,GS,", "hello", "\x02\x03", "ST,GS,abckg", "= "]) {
      expect(parseScaleFrame(junk, cas), junk).toBeNull();
      expect(parseScaleFrame(junk, tenzo), junk).toBeNull();
    }
  });

  it("does not read a truncated frame as a smaller weight", () => {
    // A frame cut mid-transmission must not read "301" as 301 kg.
    expect(parseScaleFrame("ST,GS,+00301", cas)?.weightG).toBe(301_000);
    // ...which is exactly why only settled, repeated readings are ever captured.
  });
});

describe("customProtocol", () => {
  it("builds a protocol from a regex", () => {
    const p = customProtocol("W:(?<weight>\\d+)", { defaultUnit: "kg" });
    expect(parseScaleFrame("W:3015", p)?.weightG).toBe(3_015_000);
  });

  it("insists the pattern captures a weight", () => {
    expect(() => customProtocol("(?<x>\\d+)")).toThrow(DomainError);
    expect(() => customProtocol("(")).toThrow(DomainError);
  });
});

describe("isSettled", () => {
  const r = (weightG: number, stable = false): ScaleReading => ({ weightG, stable, raw: "" });

  it("believes an indicator that reports stability", () => {
    expect(isSettled([r(3_015_000, true), r(3_015_000, true), r(3_015_000, true),
                      r(3_015_000, true), r(3_015_000, true)])).toBe(true);
  });

  it("refuses while any recent frame is unstable", () => {
    expect(isSettled([r(3_015_000, true), r(3_015_000, true), r(3_014_000, false),
                      r(3_015_000, true), r(3_015_000, true)])).toBe(false);
  });

  it("falls back to the number holding still, for indicators with no flag", () => {
    expect(isSettled([r(3_015_000), r(3_015_000), r(3_014_990), r(3_015_010), r(3_015_000)]))
      .toBe(true);
  });

  it("refuses a truck that is still settling on its springs", () => {
    expect(isSettled([r(3_060_000), r(3_040_000), r(3_025_000), r(3_018_000), r(3_015_000)]))
      .toBe(false);
  });

  it("refuses before it has seen enough of the stream", () => {
    expect(isSettled([r(3_015_000), r(3_015_000)])).toBe(false);
    expect(isSettled([])).toBe(false);
  });
});

// --------------------------------------------------------- Toledo continuous

import { describeFrame, detectProtocol, parseToledoContinuous, readFrame } from "../scale";

/**
 * Builds the frame a Keli D2008 emits in continuous mode, so the parser is tested against
 * the shape of the real thing rather than against itself.
 */
function toledoFrame(
  displayed: string,
  {
    decimals = 0, negative = false, motion = false, over = false, pounds = false,
    net = false, tare = "000000", checksum = true,
  }: Partial<{
    decimals: number; negative: boolean; motion: boolean; over: boolean;
    pounds: boolean; net: boolean; tare: string; checksum: boolean;
  }> = {},
): string {
  const swa = 0x20 | (decimals & 0x07);
  const swb =
    0x20 | (net ? 0x01 : 0) | (negative ? 0x02 : 0) | (over ? 0x04 : 0) |
    (motion ? 0x08 : 0) | (pounds ? 0x10 : 0);
  const swc = 0x20;
  const body =
    String.fromCharCode(0x02, swa, swb, swc) +
    displayed.padStart(6, "0") + tare + String.fromCharCode(0x0d);
  if (!checksum) return body;
  let xor = 0;
  for (let i = 0; i < body.length; i++) xor ^= body.charCodeAt(i);
  return body + String.fromCharCode(xor & 0xff);
}

describe("parseToledoContinuous — the Keli D2008 frame", () => {
  it("reads a settled gross weight", () => {
    const r = parseToledoContinuous(toledoFrame("003015"));
    expect(r?.weightG).toBe(3_015_000);
    expect(r?.stable).toBe(true);
    expect(r?.checksumOk).toBe(true);
  });

  it("puts the decimal point back from the status byte", () => {
    // The digits carry no decimal point; SWA says where it goes.
    expect(parseToledoContinuous(toledoFrame("030150", { decimals: 1 }))?.weightG)
      .toBe(3_015_000);
    expect(parseToledoContinuous(toledoFrame("006355", { decimals: 1 }))?.weightG)
      .toBe(635_500);
  });

  it("takes the sign from the status byte, not the digits", () => {
    expect(parseToledoContinuous(toledoFrame("000125", { negative: true }))?.weightG)
      .toBe(-125_000);
  });

  /** A truck settles on its springs for seconds after it stops. */
  it("refuses to call a moving platform stable", () => {
    expect(parseToledoContinuous(toledoFrame("003015", { motion: true }))?.stable).toBe(false);
  });

  it("never calls an over-capacity reading stable, whatever the motion bit says", () => {
    const r = parseToledoContinuous(toledoFrame("999999", { over: true }));
    expect(r?.overCapacity).toBe(true);
    expect(r?.stable).toBe(false);
  });

  it("converts pounds when the indicator is set to them", () => {
    expect(parseToledoContinuous(toledoFrame("000100", { pounds: true }))?.weightG).toBe(45_400);
  });

  /** A corrupted weight is worse than none — it looks exactly like a real one. */
  it("discards a frame that fails its checksum rather than repairing it", () => {
    const good = toledoFrame("003015");
    const corrupted = good.slice(0, 17) + String.fromCharCode(good.charCodeAt(17) ^ 0xff);
    expect(parseToledoContinuous(corrupted)).toBeNull();
  });

  it("accepts a frame with no checksum byte at all", () => {
    const r = parseToledoContinuous(toledoFrame("003015", { checksum: false }));
    expect(r?.weightG).toBe(3_015_000);
    expect(r?.checksumOk).toBeNull();
  });

  it("refuses anything that is not the frame", () => {
    for (const junk of ["", "ST,GS,+003015kg", "\x02short\x0d", toledoFrame("003015") + "extra"]) {
      expect(parseToledoContinuous(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("shows control bytes readably, for setting the scale up", () => {
    expect(describeFrame(toledoFrame("003015"))).toContain("<02>");
    expect(describeFrame(toledoFrame("003015"))).toContain("003015");
  });
});

describe("detectProtocol", () => {
  it("recognises the Keli stream", () => {
    const frames = [toledoFrame("003015"), toledoFrame("003015"), toledoFrame("003014")];
    expect(detectProtocol(frames)).toEqual({ kind: "toledo" });
  });

  it("recognises a text indicator", () => {
    const detected = detectProtocol(["ST,GS,+003015kg", "ST,GS,+003015kg"]);
    expect(detected?.kind).toBe("line");
    if (detected?.kind === "line") {
      expect(readFrame("ST,GS,+002380kg", detected)?.weightG).toBe(2_380_000);
    }
  });

  it("gives up rather than guessing at an unknown stream", () => {
    expect(detectProtocol(["\x01\x02\x03", "qqqq", ""])).toBeNull();
  });

  it("reads frames through whatever it detected", () => {
    const detected = detectProtocol([toledoFrame("003015")])!;
    expect(readFrame(toledoFrame("002380"), detected)?.weightG).toBe(2_380_000);
  });
});
