import { describe, expect, it } from "vitest";
import { Framer } from "../framer";

const bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const toledo = (digits: string) => `\x02\x20\x20\x20${digits}000000\x0d\x55`;

describe("Framer", () => {
  it("emits nothing until a frame is complete", () => {
    const f = new Framer();
    expect(f.push(bytes("\x02\x20\x20\x20003"))).toEqual([]);
    expect(f.push(bytes("015000000\x0d\x55"))).toEqual([toledo("003015")]);
  });

  /** A half-frame read as a number turns 3015 kg into 301 kg. */
  it("never emits a partial frame", () => {
    const whole = toledo("003015");
    for (let i = 1; i < whole.length; i++) {
      const probe = new Framer();
      expect(probe.push(bytes(whole.slice(0, i))), `cut at ${i}`).toEqual([]);
    }
    expect(new Framer().push(bytes(whole))).toEqual([whole]);
  });

  it("splits several frames arriving in one chunk", () => {
    const f = new Framer();
    const out = f.push(bytes(toledo("003015") + toledo("003016") + toledo("003017")));
    expect(out).toHaveLength(3);
    expect(out[1]).toBe(toledo("003016"));
  });

  it("handles a frame with no checksum, followed by the next frame", () => {
    const f = new Framer();
    const noChecksum = "\x02\x20\x20\x20003015000000\x0d";
    const out = f.push(bytes(noChecksum + toledo("003016")));
    expect(out[0]).toBe(noChecksum);
    expect(out[1]).toBe(toledo("003016"));
  });

  it("cuts plain text indicators on their line endings", () => {
    const f = new Framer();
    expect(f.push(bytes("ST,GS,+003015kg\r\nST,GS,+002380kg\r\n")))
      .toEqual(["ST,GS,+003015kg", "ST,GS,+002380kg"]);
  });

  it("does not grow without limit when the baud rate is wrong", () => {
    const f = new Framer();
    for (let i = 0; i < 50; i++) f.push(bytes("x".repeat(200)));
    expect(f.push(bytes("ST,GS,+003015kg\r\n")).length).toBeGreaterThanOrEqual(1);
  });
});
