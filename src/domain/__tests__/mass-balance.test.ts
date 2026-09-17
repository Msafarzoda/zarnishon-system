import { describe, expect, it } from "vitest";
import { massBalance, DEFAULT_YIELD_NORMS, type RunTotals } from "../mass-balance";

/** A tonne of cotton, ginned to the owner's own figures. */
const honest: RunTotals = {
  feedG: 1_000_000,
  recycledG: 0,
  chigitG: 570_000, // 57 %
  kipG: 330_000, // 33 %
  ulyukG: 10_000, // 1 %
  puchoqG: 80_000, // 8 %
};

describe("a run that balances", () => {
  it("passes the owner's own figures", () => {
    const b = massBalance(honest);
    expect(b.severity).toBe("ok");
    expect(b.findings).toHaveLength(0);
    expect(b.chigitBp).toBe(5700);
    expect(b.kipBp).toBe(3300);
    expect(b.lossG).toBe(10_000); // the 1 % that is water and dust
  });

  it("reports proportions, not only totals", () => {
    const b = massBalance(honest);
    expect(b.ulyukBp).toBe(100);
    expect(b.puchoqBp).toBe(800);
  });
});

describe("what the balance is for", () => {
  it("catches lint leaving the building", () => {
    // Five tonnes in a hundred, gone. The seed is right, the bales are short.
    const b = massBalance({ ...honest, kipG: 280_000 });
    expect(b.severity).toBe("alarm");
    expect(b.findings.map((f) => f.code)).toContain("loss-too-high");
  });

  it("catches bales weighed light even when the sum still adds up", () => {
    // The classic: every bale entered ten kilos short, the missing lint reappears as
    // "loss", the arithmetic is consistent, and only the yield percentage shows it.
    const b = massBalance({ ...honest, kipG: 300_000, puchoqG: 110_000 });
    expect(b.lossG).toBe(10_000); // unchanged — the total balances perfectly
    expect(b.findings.map((f) => f.code)).toContain("kip-out-of-range");
    expect(b.severity).not.toBe("ok");
  });

  it("refuses a run where more came out than went in", () => {
    const b = massBalance({ ...honest, chigitG: 700_000 });
    expect(b.lossG).toBeLessThan(0);
    expect(b.severity).toBe("alarm");
    expect(b.findings.map((f) => f.code)).toContain("outputs-exceed-input");
  });

  it("refuses outputs with no recorded input at all", () => {
    const b = massBalance({ ...honest, feedG: 0 });
    expect(b.findings.map((f) => f.code)).toContain("no-feed");
    expect(b.severity).toBe("alarm");
  });

  /*
   * A run the молшинос opened thirty seconds ago. Nothing has gone in and nothing has
   * come out, so there is nothing to find — and an alarm here would be on screen at the
   * start of every shift, which is how a real one stops being noticed.
   */
  it("says nothing at all about a run with nothing recorded yet", () => {
    const b = massBalance({
      feedG: 0, recycledG: 0, chigitG: 0, kipG: 0, ulyukG: 0, puchoqG: 0,
    });
    expect(b.findings).toEqual([]);
    expect(b.severity).toBe("ok");
  });
});

describe("recycled улюк is not counted as new cotton", () => {
  it("keeps recycled mass out of the yield denominator", () => {
    // 100 kg of улюк fed back. It is real mass through the machines, but the lint it
    // yields was already paid for once — counting it as input would make the factory
    // look as though it produced lint from nothing.
    const withRecycled = massBalance({
      ...honest,
      recycledG: 100_000,
      kipG: 330_000 + 30_000,
      puchoqG: 80_000 + 70_000,
    });
    // Yield is still measured against the 1 000 kg that was bought.
    expect(withRecycled.chigitBp).toBe(5700);
    // And the extra mass is accounted for on the input side, so nothing goes "missing".
    expect(withRecycled.lossG).toBe(10_000);
    expect(withRecycled.severity).toBe("ok");
  });

  it("would have flagged the same run if recycled mass were ignored", () => {
    // The same outputs with the recycled feed unrecorded: 100 kg appears from nowhere.
    const ignored = massBalance({
      ...honest,
      recycledG: 0,
      kipG: 360_000,
      puchoqG: 150_000,
    });
    expect(ignored.lossG).toBeLessThan(0);
    expect(ignored.severity).toBe("alarm");
  });
});

describe("the norms are the owner's, and can be changed", () => {
  it("accepts a run inside widened bounds", () => {
    const odd = { ...honest, chigitG: 520_000, puchoqG: 130_000 };
    expect(massBalance(odd).severity).not.toBe("ok");
    expect(
      massBalance(odd, {
        ...DEFAULT_YIELD_NORMS,
        chigitBp: { min: 5000, max: 6200 },
        maxLossBp: 2000,
      }).severity,
    ).toBe("ok");
  });
});

/**
 * Half a shift in: the conveyor has been running since six, the hopper has not been
 * emptied and the press has made nothing yet.
 *
 * Judged as if the shift were over, this run looks like a catastrophe — a hundred per
 * cent loss, no seed, no lint. It is the ordinary state of every shift for its first few
 * hours, which is exactly why it must not raise anything.
 */
describe("a run that is still going", () => {
  const midShift = {
    feedG: 24_500_000, recycledG: 0,
    chigitG: 0, kipG: 0, ulyukG: 0, puchoqG: 0,
  };

  it("says nothing about yields or loss until the run is closed", () => {
    const open = massBalance(midShift, undefined, "open");
    expect(open.findings).toEqual([]);
    expect(open.severity).toBe("ok");
    expect(open.final).toBe(false);
    // The figures are still computed — the floor wants its running totals.
    expect(open.lossG).toBe(24_500_000);
    expect(open.lossBp).toBe(10_000);
  });

  it("judges the same numbers once the run is closed", () => {
    const closed = massBalance(midShift, undefined, "closed");
    expect(closed.findings.map((f) => f.code)).toContain("loss-too-high");
    expect(closed.severity).toBe("alarm");
    expect(closed.final).toBe(true);
  });

  /*
   * The one thing that is wrong at any moment of any shift. More cannot come out than
   * went in, and waiting for the run to close to say so would let an operator carry on
   * recording against a figure that is already impossible.
   */
  it("still refuses more coming out than went in, mid-shift", () => {
    const impossible = massBalance(
      { feedG: 10_000_000, recycledG: 0, chigitG: 9_000_000, kipG: 5_000_000,
        ulyukG: 0, puchoqG: 0 },
      undefined,
      "open",
    );
    expect(impossible.findings.map((f) => f.code)).toEqual(["outputs-exceed-input"]);
    expect(impossible.severity).toBe("alarm");
  });
});
