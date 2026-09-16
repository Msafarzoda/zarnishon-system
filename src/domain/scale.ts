import { DomainError, divRound } from "./units";

/**
 * Reading a weighbridge indicator.
 *
 * The indicator streams short ASCII frames down a serial line, several times a second.
 * Two things in each frame matter: the number, and whether the reading is **stable**.
 *
 * Stability is not a detail. A loaded truck settles on its springs for several seconds
 * after it stops, and a reading taken while it is still rocking can be out by tens of
 * kilograms — on cotton at 12.50 сомонӣ/кг that is real money, in whichever direction
 * happens to suit whoever pressed the button. The factory only ever records a frame the
 * indicator itself declares stable.
 *
 * The exact wording differs by manufacturer, so the protocol is configuration, not code.
 */

export type ScaleUnit = "kg" | "g" | "t" | "lb";

export interface ScaleProtocol {
  /** Name shown in settings, e.g. "CAS / Toledo ASCII". */
  id: string;
  /**
   * Must capture the number in a group named `weight`, and — where the indicator says so
   * — the stability flag in a group named `status`.
   */
  pattern: RegExp;
  /** Values of the `status` group that mean the reading has settled. */
  stableTokens: readonly string[];
  /** Unit the indicator reports in, when the frame does not carry one. */
  defaultUnit: ScaleUnit;
}

/**
 * Protocols seen on cotton weighbridges in the region. If an indicator is not listed,
 * `customProtocol()` builds one from a regex without touching this file.
 *
 * The Keli D2008 on this weighbridge streams the Toledo continuous frame, which is not a
 * line of text and is handled separately by `parseToledoContinuous`.
 */
export const SCALE_PROTOCOLS: Record<string, ScaleProtocol> = {
  /** "ST,GS,+003015.0kg" — CAS, Toledo and most indicators that imitate them. */
  cas: {
    id: "CAS / Toledo ASCII",
    pattern:
      /(?<status>ST|US|OL)\s*,\s*(?:GS|NT|G|N)\s*,\s*(?<weight>[+-]?\s*\d+(?:[.,]\d+)?)\s*(?<unit>kg|g|t|lb)?/i,
    stableTokens: ["ST"],
    defaultUnit: "kg",
  },
  /** "=  3015" or "= +3015" — Tenzo-M and similar CIS indicators. */
  tenzo: {
    id: "Tenzo-M",
    pattern: /^=\s*(?<weight>[+-]?\s*\d+(?:[.,]\d+)?)/,
    stableTokens: [],
    defaultUnit: "kg",
  },
  /** A bare signed number on its own line — the simplest continuous output. */
  plain: {
    id: "Plain number",
    pattern: /^\s*(?<weight>[+-]?\d+(?:[.,]\d+)?)\s*(?<unit>kg|g|t|lb)?\s*$/i,
    stableTokens: [],
    defaultUnit: "kg",
  },
};

export interface ScaleReading {
  /** Integer grams — the same unit every weight in the system is kept in. */
  weightG: number;
  /** Whether the indicator declared this frame settled. Only meaningful when
   *  `stabilityKnown` is true. */
  stable: boolean;
  /**
   * Whether this indicator reports stability at all.
   *
   * The distinction decides everything: an indicator that says "in motion" must be
   * believed, and no amount of the number looking steady may override it. A truck
   * oscillating slowly passes right through a numeric "has it stopped changing?" test
   * while it is still settling, and the weight captured is then wrong.
   */
  stabilityKnown: boolean;
  /** The frame exactly as it came off the wire, stored with the weighing. */
  raw: string;
}

const UNIT_TO_GRAMS: Record<ScaleUnit, number> = { kg: 1000, g: 1, t: 1_000_000, lb: 454 };

/**
 * Parse one frame. Returns `null` for anything that does not match — serial lines carry
 * partial frames, keep-alives and line noise, and a reader that guessed at those would
 * be inventing weights.
 */
export function parseScaleFrame(
  frame: string,
  protocol: ScaleProtocol,
): ScaleReading | null {
  const match = protocol.pattern.exec(frame);
  const groups = match?.groups;
  if (!groups?.weight) return null;

  // Indicators pad with spaces: "+ 003015" is one number, not two.
  const text = groups.weight.replace(/\s+/g, "").replace(",", ".");
  const value = Number(text);
  if (!Number.isFinite(value)) return null;

  const unit = ((groups.unit?.toLowerCase() as ScaleUnit) || protocol.defaultUnit);
  const perUnit = UNIT_TO_GRAMS[unit];
  if (!perUnit) return null;

  const weightG = divRound(Math.round(value * 1000) * perUnit, 1000);

  const status = groups.status?.toUpperCase();
  const stabilityKnown = status !== undefined && protocol.stableTokens.length > 0;
  const stable = stabilityKnown ? protocol.stableTokens.includes(status!) : false;

  return { weightG, stable, stabilityKnown, raw: frame.trim() };
}

/** Build a protocol for an indicator not in the list above, without changing code. */
export function customProtocol(
  source: string,
  opts: { stableTokens?: string[]; defaultUnit?: ScaleUnit } = {},
): ScaleProtocol {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "i");
  } catch {
    throw new DomainError(`Invalid scale pattern: ${source}`);
  }
  if (!source.includes("(?<weight>")) {
    throw new DomainError("A scale pattern must capture a group named `weight`.");
  }
  return {
    id: "Custom",
    pattern,
    stableTokens: opts.stableTokens ?? [],
    defaultUnit: opts.defaultUnit ?? "kg",
  };
}

/**
 * Decide whether a run of readings has settled, for indicators that do not say so
 * themselves: the last `samples` readings must all sit within `toleranceG` of each other.
 *
 * A truck settles on its springs for several seconds after it stops. Without this, the
 * weight captured is whichever moment the operator happened to press the button.
 */
export function isSettled(
  readings: readonly ScaleReading[],
  { samples = 5, toleranceG = 1_000 }: { samples?: number; toleranceG?: number } = {},
): boolean {
  if (readings.length < samples) return false;
  const window = readings.slice(-samples);

  // An indicator that reports stability is believed, and believed absolutely. It has the
  // load cell; we have a number that arrived a moment ago. Falling back to "the number
  // looks steady" when it says otherwise is how a truck still settling on its springs
  // gets captured — the oscillation is slow near the turning points, so a few frames in
  // a row can sit within any tolerance while the platform is plainly still moving.
  if (window.some((r) => r.stabilityKnown)) {
    return window.every((r) => r.stabilityKnown && r.stable);
  }

  // Only for indicators with no stability flag at all: has the number stopped changing?
  // The default tolerance is below one division of any weighbridge, so in practice this
  // means the readings are identical, while still forgiving an indicator that reports
  // in grams and jitters on the last digit.
  const weights = window.map((r) => r.weightG);
  return Math.max(...weights) - Math.min(...weights) <= toleranceG;
}


// --------------------------------------------------------- Toledo continuous

/**
 * The Toledo continuous frame, which Keli indicators (D2008 among them) emit several
 * times a second in continuous mode:
 *
 *     STX  SWA  SWB  SWC  wwwwww  tttttt  CR  [CHK]
 *
 * It is a fixed-width binary frame, not a line of text: the weight digits carry no sign,
 * no decimal point and no unit — all three live in the status bytes.
 *
 *   SWA  bits 0-2  where the decimal point goes
 *   SWB  bit 0 (0x01)  net rather than gross
 *        bit 1 (0x02)  negative
 *        bit 2 (0x04)  over or under capacity — the number is meaningless
 *        bit 3 (0x08)  in motion; the truck has not settled
 *        bit 4 (0x10)  pounds rather than kilograms
 *
 * CHK, when present, is the XOR of every byte from STX through CR. A frame that fails
 * its checksum is discarded rather than repaired: a corrupted weight is worse than no
 * weight, because it looks exactly like a real one.
 */
export const STX = 0x02;
export const ETX = 0x03;
export const CR = 0x0d;

export interface ToledoReading extends ScaleReading {
  net: boolean;
  overCapacity: boolean;
  checksumOk: boolean | null;
}

export function parseToledoContinuous(frame: string): ToledoReading | null {
  // STX + 3 status + 6 weight + 6 tare + CR = 17, plus an optional checksum byte.
  if (frame.length < 17 || frame.length > 18) return null;
  if (frame.charCodeAt(0) !== STX || frame.charCodeAt(16) !== CR) return null;

  const swa = frame.charCodeAt(1);
  const swb = frame.charCodeAt(2);

  const digits = frame.slice(4, 10);
  if (!/^[\d\s]{6}$/.test(digits)) return null;
  const magnitude = Number(digits.replace(/\s/g, ""));
  if (!Number.isFinite(magnitude)) return null;

  const decimals = swa & 0x07;
  const negative = (swb & 0x02) !== 0;
  const overCapacity = (swb & 0x04) !== 0;
  const inMotion = (swb & 0x08) !== 0;
  const pounds = (swb & 0x10) !== 0;

  // The displayed number is the digits with the decimal point put back.
  const perUnit = UNIT_TO_GRAMS[pounds ? "lb" : "kg"];
  const scaled = divRound(magnitude * perUnit, 10 ** decimals);

  let checksumOk: boolean | null = null;
  if (frame.length === 18) {
    let xor = 0;
    for (let i = 0; i <= 16; i++) xor ^= frame.charCodeAt(i);
    checksumOk = (xor & 0xff) === (frame.charCodeAt(17) & 0xff);
    if (!checksumOk) return null;
  }

  return {
    weightG: negative ? -scaled : scaled,
    // Over capacity is never a usable reading, whatever the motion bit says.
    stable: !inMotion && !overCapacity,
    // The Toledo frame always carries a motion bit, so stability is always known.
    stabilityKnown: true,
    raw: describeFrame(frame),
    net: (swb & 0x01) !== 0,
    overCapacity,
    checksumOk,
  };
}

/** A frame as printable text, for storing with the weighing and for setting the scale up. */
export function describeFrame(frame: string): string {
  return [...frame]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code > 0x7e
        ? `<${code.toString(16).padStart(2, "0").toUpperCase()}>`
        : ch;
    })
    .join("");
}

// ------------------------------------------------------------------ detection

export type DetectedProtocol =
  /** The Keli D2008 on this weighbridge: STX, sign, seven digits, checksum, ETX. */
  | { kind: "keli" }
  | { kind: "toledo" }
  | { kind: "line"; protocol: ScaleProtocol };

/**
 * Work out what an indicator is speaking from a sample of its output.
 *
 * The manual says "a short ASCII string with an XOR checksum", which describes several
 * incompatible formats. Rather than assume, the station listens for a moment and picks
 * the protocol that reads the **most** frames in the sample — and the setup screen shows
 * the raw bytes next to the weight so a human can confirm it against the display before
 * a single truck is weighed on it.
 */
export function detectProtocol(frames: readonly string[]): DetectedProtocol | null {
  // Tried before the text protocols: a binary frame can contain digits that a loose text
  // pattern would happily match, and reading it as text would give a plausible wrong
  // number rather than an obvious failure.
  const keliHits = frames.filter((f) => parseKeliStxEtx(f) !== null).length;
  if (keliHits >= 2) return { kind: "keli" };

  const toledoHits = frames.filter((f) => parseToledoContinuous(f) !== null).length;

  let best: { protocol: ScaleProtocol; hits: number } | null = null;
  for (const protocol of Object.values(SCALE_PROTOCOLS)) {
    const hits = frames.filter((f) => parseScaleFrame(f, protocol) !== null).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { protocol, hits };
  }

  if (toledoHits === 0 && !best) return null;
  if (toledoHits >= (best?.hits ?? 0)) return { kind: "toledo" };
  return { kind: "line", protocol: best!.protocol };
}

/** Read one frame with whichever protocol was detected. */
export function readFrame(frame: string, detected: DetectedProtocol): ScaleReading | null {
  switch (detected.kind) {
    case "keli":
      return parseKeliStxEtx(frame);
    case "toledo":
      return parseToledoContinuous(frame);
    default:
      return parseScaleFrame(frame, detected.protocol);
  }
}

/**
 * What the port is actually doing, from the evidence. A pure function so the commissioning
 * screen and its tests agree on what each symptom means.
 *
 * Every one of these looks identical to an operator — the weight simply never appears —
 * and every one has a different fix. Naming them is the difference between "the scale is
 * broken" and "the indicator is not in continuous mode".
 */
export type ScaleDiagnosis =
  /** No port open yet. */
  | "not-connected"
  /** Port open, not one byte has arrived. Cable, port, or the indicator is not sending. */
  | "no-bytes"
  /** Bytes are arriving but no frame boundary is ever found — almost always the baud rate. */
  | "bytes-no-frames"
  /** Whole frames are being cut, but none matches a protocol we know. */
  | "frames-no-parse"
  /** Frames parse and weights are coming through. */
  | "streaming";

export function diagnoseScale(evidence: {
  portOpen: boolean;
  bytesReceived: number;
  framesCut: number;
  readingsParsed: number;
}): ScaleDiagnosis {
  if (!evidence.portOpen) return "not-connected";
  if (evidence.bytesReceived === 0) return "no-bytes";
  if (evidence.framesCut === 0) return "bytes-no-frames";
  if (evidence.readingsParsed === 0) return "frames-no-parse";
  return "streaming";
}

/**
 * A chunk of bytes rendered so a person can look at it: printable ASCII as itself, control
 * and high bytes as two-digit hex in angle brackets.
 *
 * At the wrong baud rate the stream is not text at all, and a screen that only prints
 * printable characters shows a convincing-looking blank. The hex is the evidence.
 */
export function describeBytes(bytes: readonly number[]): string {
  return bytes
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `<${b.toString(16).padStart(2, "0")}>`))
    .join("");
}

// ------------------------------------------------- Keli D2008, STX…ETX frame

/**
 * The frame this factory's Keli D2008 actually emits, confirmed against the indicator:
 *
 *   STX  sign  d d d d d d d  c c  ETX
 *   02   +/-   seven digits   XOR  03
 *
 * Twelve bytes. The weight is the seven digits with leading zeros stripped; the two
 * characters before ETX are the XOR of the eight bytes between STX and them — the sign
 * and the digits — written as hex.
 *
 * **This frame says nothing about stability.** There is no motion bit, so `stabilityKnown`
 * is false and settling is decided by the number holding still across several frames.
 * That is weaker than an indicator's own motion flag and it is why the window is exact
 * rather than tolerant: at ~5 frames a second, five identical readings is roughly a
 * second of genuine stillness, and a truck rocking on its springs does not produce that.
 *
 * A frame failing its checksum is discarded, never repaired. A corrupted weight is worse
 * than no weight, because it looks exactly like a real one.
 */
export interface KeliReading extends ScaleReading {
  checksumOk: boolean;
  /** The sign as sent. Negative readings are real — a platform can read below zero. */
  negative: boolean;
}

/** Length of the whole frame, STX and ETX included. */
const KELI_FRAME_LEN = 12;

export function parseKeliStxEtx(
  frame: string,
  { unit = "kg" as ScaleUnit } = {},
): KeliReading | null {
  if (frame.length !== KELI_FRAME_LEN) return null;
  if (frame.charCodeAt(0) !== STX) return null;
  if (frame.charCodeAt(KELI_FRAME_LEN - 1) !== ETX) return null;

  const sign = frame[1]!;
  if (sign !== "+" && sign !== "-") return null;

  const digits = frame.slice(2, 9);
  if (!/^\d{7}$/.test(digits)) return null;

  const declared = frame.slice(9, 11);
  if (!/^[0-9a-fA-F]{2}$/.test(declared)) return null;

  // XOR of the sign and the seven digits — the eight bytes between STX and the checksum.
  let xor = 0;
  for (let i = 1; i <= 8; i++) xor ^= frame.charCodeAt(i);
  const checksumOk = xor === parseInt(declared, 16);
  if (!checksumOk) return null;

  const magnitude = Number(digits);
  if (!Number.isFinite(magnitude)) return null;

  const weightG = (sign === "-" ? -1 : 1) * magnitude * UNIT_TO_GRAMS[unit];

  return {
    weightG,
    // No motion bit in this frame: nothing here may be read as "the platform has settled".
    stable: false,
    stabilityKnown: false,
    negative: sign === "-",
    checksumOk: true,
    raw: frame,
  };
}

/** The checksum an indicator should send for a given sign and digits. For tests and tools. */
export function keliChecksum(signAndDigits: string): string {
  let xor = 0;
  for (let i = 0; i < signAndDigits.length; i++) xor ^= signAndDigits.charCodeAt(i);
  return xor.toString(16).toUpperCase().padStart(2, "0");
}

/** Builds a well-formed frame. Used by the simulator and by the tests. */
export function encodeKeliFrame(kg: number): string {
  const negative = kg < 0;
  const digits = String(Math.abs(Math.round(kg))).padStart(7, "0").slice(-7);
  const body = `${negative ? "-" : "+"}${digits}`;
  return `${String.fromCharCode(STX)}${body}${keliChecksum(body)}${String.fromCharCode(ETX)}`;
}
