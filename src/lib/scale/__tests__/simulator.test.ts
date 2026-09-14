import { describe, expect, it } from "vitest";
import { parseToledoContinuous } from "@/domain/scale";
import { encodeToledoFrame, simulatedReading } from "../simulator";

/**
 * The simulator is only worth anything if it produces frames the real parser accepts —
 * otherwise a green test run says nothing about the weighbridge.
 */
describe("encodeToledoFrame", () => {
  it("produces frames the real parser reads back exactly", () => {
    for (const kg of [0, 635, 2380, 3015, 45_000]) {
      const reading = parseToledoContinuous(encodeToledoFrame(kg));
      expect(reading?.weightG, `${kg} kg`).toBe(kg * 1000);
      expect(reading?.checksumOk).toBe(true);
    }
  });

  it("round-trips a decimal display", () => {
    expect(parseToledoContinuous(encodeToledoFrame(635.5, { decimals: 1 }))?.weightG)
      .toBe(635_500);
  });

  it("carries the motion flag through", () => {
    expect(parseToledoContinuous(encodeToledoFrame(3015, { motion: true }))?.stable).toBe(false);
    expect(parseToledoContinuous(encodeToledoFrame(3015))?.stable).toBe(true);
  });
});

describe("simulatedReading", () => {
  it("is in motion while the truck is still settling", () => {
    expect(simulatedReading(3015, 0).motion).toBe(true);
    expect(simulatedReading(3015, 2000).motion).toBe(true);
  });

  it("settles on the true weight", () => {
    expect(simulatedReading(3015, 4000)).toEqual({ displayedKg: 3015, motion: false });
    expect(simulatedReading(3015, 9000)).toEqual({ displayedKg: 3015, motion: false });
  });

  /** The point of the exercise: an early reading is wrong, sometimes by a lot. */
  it("reads differently early on, which is why capture waits", () => {
    const early = simulatedReading(3015, 200).displayedKg;
    expect(Math.abs(early - 3015)).toBeGreaterThan(0);
  });
});
