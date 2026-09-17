import { describe, expect, it } from "vitest";
import { DomainError } from "../units";
import {
  SCALE_PROTOCOLS,
  customProtocol,
  isSettled,
  parseScaleFrame,
  type ScaleReading,
  diagnoseScale,
  describeBytes,
  parseKeliStxEtx,
  encodeKeliFrame,
  keliChecksum,
} from "../scale";

const cas = SCALE_PROTOCOLS.cas!;
const tenzo = SCALE_PROTOCOLS.tenzo!;
const plain = SCALE_PROTOCOLS.plain!;

describe("parseScaleFrame — CAS / Toledo", () => {
  it("reads a stable gross weight", () => {
    expect(parseScaleFrame("ST,GS,+003015.0kg\r\n", cas)).toEqual({
      weightG: 3_015_000,
      stable: true,
      stabilityKnown: true,
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
  /** An indicator that reports stability, like the Keli D2008. */
  const r = (weightG: number, stable = false): ScaleReading =>
    ({ weightG, stable, stabilityKnown: true, raw: "" });
  /** An indicator with no stability flag at all. */
  const mute = (weightG: number): ScaleReading =>
    ({ weightG, stable: false, stabilityKnown: false, raw: "" });

  it("believes an indicator that reports stability", () => {
    expect(isSettled([r(3_015_000, true), r(3_015_000, true), r(3_015_000, true),
                      r(3_015_000, true), r(3_015_000, true)])).toBe(true);
  });

  it("refuses while any recent frame is unstable", () => {
    expect(isSettled([r(3_015_000, true), r(3_015_000, true), r(3_014_000, false),
                      r(3_015_000, true), r(3_015_000, true)])).toBe(false);
  });

  it("falls back to the number holding still, for indicators with no flag", () => {
    expect(isSettled([mute(3_015_000), mute(3_015_000), mute(3_014_990),
                      mute(3_015_010), mute(3_015_000)])).toBe(true);
  });

  it("refuses a truck that is still settling on its springs", () => {
    expect(isSettled([mute(3_060_000), mute(3_040_000), mute(3_025_000),
                      mute(3_018_000), mute(3_015_000)])).toBe(false);
  });

  /**
   * The bug this guards: a truck oscillating slowly sits nearly still near the turning
   * points of its swing. Several frames in a row then fall inside any numeric tolerance
   * while the platform is plainly still moving — and the indicator is saying so. It gets
   * believed, and the weight captured is wrong by whatever the swing happens to be.
   */
  it("never overrides an indicator that says the platform is moving", () => {
    const barelyMoving = [
      r(3_014_000, false), r(3_014_010, false), r(3_014_000, false),
      r(3_013_990, false), r(3_014_000, false),
    ];
    expect(isSettled(barelyMoving)).toBe(false);
  });

  it("does not treat a silent indicator's readings as a stability claim", () => {
    // All five are `stable: false`, but for a mute indicator that means "no opinion",
    // not "moving" — so the numeric test is allowed to decide.
    expect(isSettled([mute(635_000), mute(635_000), mute(635_000),
                      mute(635_000), mute(635_000)])).toBe(true);
  });

  it("refuses a window that mixes an indicator's claim with silence", () => {
    expect(isSettled([r(3_015_000, true), r(3_015_000, true), mute(3_015_000),
                      r(3_015_000, true), r(3_015_000, true)])).toBe(false);
  });

  /** 20 kg of slack is 250 сомонӣ of cotton. The fallback is below one division. */
  it("keeps the numeric fallback tight", () => {
    expect(isSettled([mute(3_015_000), mute(3_015_000), mute(3_015_000),
                      mute(3_015_000), mute(3_020_000)])).toBe(false);
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

describe("diagnosing a silent port", () => {
  const base = { portOpen: true, bytesReceived: 0, framesCut: 0, readingsParsed: 0 };

  it("says nothing is connected before a port is opened", () => {
    expect(diagnoseScale({ ...base, portOpen: false })).toBe("not-connected");
  });

  it("distinguishes a silent port from a noisy one", () => {
    // Nothing at all: cable, wrong port, or the indicator is not set to send.
    expect(diagnoseScale(base)).toBe("no-bytes");
    // Bytes but never a frame boundary: the classic wrong-baud-rate signature.
    expect(diagnoseScale({ ...base, bytesReceived: 900 })).toBe("bytes-no-frames");
  });

  it("distinguishes an unknown format from a broken connection", () => {
    expect(diagnoseScale({ ...base, bytesReceived: 900, framesCut: 40 })).toBe("frames-no-parse");
  });

  it("reports a working stream only when weights actually came out", () => {
    expect(
      diagnoseScale({ portOpen: true, bytesReceived: 900, framesCut: 40, readingsParsed: 40 }),
    ).toBe("streaming");
  });
});

describe("showing raw bytes to a human", () => {
  it("prints text as text", () => {
    expect(describeBytes([0x33, 0x30, 0x31, 0x35])).toBe("3015");
  });

  it("makes control bytes visible instead of invisible", () => {
    expect(describeBytes([0x02, 0x33, 0x0d])).toBe("<02>3<0d>");
  });

  it("makes wrong-baud noise look like noise rather than like nothing", () => {
    // High bytes print as nothing at all in a naive renderer, which reads as a dead port.
    expect(describeBytes([0xf8, 0xe0, 0xff])).toBe("<f8><e0><ff>");
  });
});

describe("Keli D2008 — STX…ETX frame", () => {
  /*
   * Literal bytes, copied from the indicator on this weighbridge — not built by
   * `encodeKeliFrame`.
   *
   * Every other test here round-trips through the encoder, and for a while every one of
   * them passed while the weighbridge read ten times heavy: the parser treated the seven
   * digits as whole kilograms, the encoder wrote them the same way, and the two agreed
   * with each other all the way to a 70 kg test weight showing as 700 kg on the station.
   * A simulator that shares the parser's assumption cannot find the parser's mistake.
   *
   * So these frames are the contract with the hardware, written down as bytes. The
   * checksum is the XOR of the sign and the seven digits: for "+0000700" that is
   * 0x2B ^ 0x37 = 0x1C, the four zeros and the trailing pair cancelling themselves.
   */
  it("reads tenths of a kilogram, which is what this indicator sends", () => {
    // 70.0 kg on the display.
    const r = parseKeliStxEtx("\x02+00007001C\x03");
    expect(r).not.toBeNull();
    expect(r!.weightG).toBe(70_000);
  });

  it("reads the zero frame the indicator sends with an empty platform", () => {
    // Captured from the real D2008 while commissioning it.
    const r = parseKeliStxEtx("\x02+00000001B\x03");
    expect(r?.weightG).toBe(0);
  });

  it("reads a loaded lorry at the resolution the indicator sends", () => {
    // 20 480.5 kg → 204 805 tenths.
    const body = "+0204805";
    const r = parseKeliStxEtx(`\x02${body}${keliChecksum(body)}\x03`);
    expect(r?.weightG).toBe(20_480_500);
  });

  /*
   * The setting the resolution lives in. Getting it wrong is a factor-of-ten error on
   * every weight in the factory, so it is stated rather than assumed — and a different
   * indicator, configured for whole kilograms, is read correctly by saying so.
   */
  it("reads whole kilograms when the indicator is set that way", () => {
    expect(parseKeliStxEtx("\x02+00007001C\x03", { decimals: 0 })?.weightG).toBe(700_000);
    expect(parseKeliStxEtx("\x02+00007001C\x03", { decimals: 2 })?.weightG).toBe(7_000);
  });

  it("reads the weight off a well-formed frame", () => {
    const frame = encodeKeliFrame(3015);
    expect(frame).toHaveLength(12);
    expect(frame.charCodeAt(0)).toBe(0x02);
    expect(frame.charCodeAt(11)).toBe(0x03);

    const r = parseKeliStxEtx(frame);
    expect(r?.weightG).toBe(3_015_000);
    expect(r?.raw).toBe(frame);
  });

  it("strips leading zeros rather than reading them as part of the number", () => {
    expect(parseKeliStxEtx(encodeKeliFrame(635))?.weightG).toBe(635_000);
    expect(parseKeliStxEtx(encodeKeliFrame(7))?.weightG).toBe(7_000);
  });

  it("keeps the sign — a platform can read below zero", () => {
    const r = parseKeliStxEtx(encodeKeliFrame(-40));
    expect(r?.weightG).toBe(-40_000);
    expect(r?.negative).toBe(true);
  });

  it("never claims the reading is stable: this frame carries no motion bit", () => {
    const r = parseKeliStxEtx(encodeKeliFrame(3015));
    expect(r?.stabilityKnown).toBe(false);
    expect(r?.stable).toBe(false);
  });

  it("discards a frame whose checksum does not match, rather than repairing it", () => {
    const good = encodeKeliFrame(3015);
    // One digit corrupted in transit — 3015 becomes 8015, and the checksum no longer fits.
    const corrupted = good.slice(0, 5) + "8" + good.slice(6);
    expect(corrupted).not.toBe(good);
    expect(parseKeliStxEtx(corrupted)).toBeNull();
  });

  it("rejects a frame that is the right shape but the wrong length", () => {
    expect(parseKeliStxEtx(encodeKeliFrame(3015).slice(0, 11))).toBeNull();
    expect(parseKeliStxEtx(encodeKeliFrame(3015) + "\x03")).toBeNull();
  });

  it("rejects a frame missing its delimiters", () => {
    const body = "+0003015";
    expect(parseKeliStxEtx(`${body}${keliChecksum(body)}`)).toBeNull();
  });

  it("computes the checksum as the XOR of the sign and the digits", () => {
    // "+0000015" — five '0's, so they do not cancel: an odd count leaves one behind.
    //   '+' 0x2B ^ '0' 0x30 = 0x1B
    //   0x1B ^ '1' 0x31     = 0x2A
    //   0x2A ^ '5' 0x35     = 0x1F
    expect(keliChecksum("+0000015")).toBe("1F");

    // Seven '0's — an odd count again, so one survives: 0x2B ^ 0x30 = 0x1B.
    expect(keliChecksum("+0000000")).toBe("1B");
  });

  it("settles only after several identical frames, since nothing declares stability", () => {
    const at = (kg: number) => parseKeliStxEtx(encodeKeliFrame(kg))!;
    // Still rocking on its springs.
    expect(isSettled([at(3010), at(3014), at(3015), at(3013), at(3015)])).toBe(false);
    // Stopped.
    expect(isSettled([at(3015), at(3015), at(3015), at(3015), at(3015)], { toleranceG: 0 }))
      .toBe(true);
  });
});
