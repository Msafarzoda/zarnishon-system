import { assertNonNegativeInt, divRound } from "./units";

/**
 * Тавозуни вазн — does what came out of the factory account for what went in?
 *
 *     пахтаи фиристодашуда  =  чигит + кип + улюк + пучоқ + талафот
 *
 * This is the anti-fraud control for the factory half, and it is a different one from
 * everything in §2–§4. Those stop a farm losing a kilogram at the weighbridge. This stops
 * the factory losing a tonne at the press — and lint is the valuable output, so it is the
 * larger of the two risks by a wide margin. docs/domain.md §7.
 *
 * It is a check on *proportions*, not only on totals. A run can balance perfectly and
 * still be wrong: if the bales are systematically weighed ten kilograms light, the missing
 * lint reappears as "loss", the sum still adds up, and only the yield percentage shows it.
 * So both are reported.
 */

export interface RunTotals {
  /** Primary cotton fed in. Recycled улюк is excluded — see `recycledG`. */
  feedG: number;
  /**
   * Улюк fed back through. Counted separately because counting it as input would inflate
   * throughput and break every percentage below: the lint it yields was already paid for
   * once, in the run that produced it.
   */
  recycledG: number;
  chigitG: number;
  /** Sum of the bales pressed in this run. */
  kipG: number;
  ulyukG: number;
  puchoqG: number;
}

export interface YieldNorms {
  /** Basis points. 5700 = 57 %. */
  chigitBp: { min: number; max: number };
  kipBp: { min: number; max: number };
  /** The most that may go unaccounted for before it stops being moisture and dust. */
  maxLossBp: number;
}

/**
 * The owner's figures, as targets. They are not measured tolerances — the ranges want
 * widening or narrowing once a season of real runs has been seen, which is a decision for
 * the owner and not something to quietly tune in code. docs/domain.md §7.
 */
export const DEFAULT_YIELD_NORMS: YieldNorms = {
  chigitBp: { min: 5400, max: 6000 }, // owner says 56–58 %, with room either side
  kipBp: { min: 3100, max: 3600 }, // ~33 %
  /**
   * Three per cent, and deliberately tight.
   *
   * This is **only what nothing accounts for** — пучоқ is weighed and counted as its own
   * output, so what is left here is moisture and dust, not trash. A first attempt allowed
   * fifteen per cent on the muddled assumption that пучоқ lived in here too, and at that
   * setting five tonnes of lint could go missing from a hundred and raise nothing louder
   * than a warning. The limit has to be near the real figure or it protects nobody.
   */
  maxLossBp: 300,
};

export type MassBalanceSeverity = "ok" | "warn" | "alarm";

export interface MassBalanceFinding {
  code:
    | "no-feed"
    | "outputs-exceed-input"
    | "loss-too-high"
    | "chigit-out-of-range"
    | "kip-out-of-range";
  severity: MassBalanceSeverity;
  titleTg: string;
  detail: string;
}

export interface MassBalance {
  feedG: number;
  recycledG: number;
  outputG: number;
  /** Input minus outputs. Negative means more came out than went in, which is impossible. */
  lossG: number;
  lossBp: number;
  chigitBp: number;
  kipBp: number;
  ulyukBp: number;
  puchoqBp: number;
  findings: MassBalanceFinding[];
  severity: MassBalanceSeverity;
  /** False while the run is open: the proportions are not yet worth judging. */
  final: boolean;
}

/** Basis points of `part` in `whole`, guarding the empty run. */
function bp(part: number, whole: number): number {
  return whole === 0 ? 0 : divRound(part * 10_000, whole);
}

/**
 * Whether the run is finished, and therefore whether its proportions mean anything.
 *
 * The equation is a **shift-level reconciliation**, not a running total. Cotton goes onto
 * the conveyor from the first minute, and the чигит is weighed off when the hopper is
 * emptied and the bales when the press has made them — so for most of an open shift the
 * inputs are hours ahead of the outputs, and the loss reads near a hundred per cent with
 * nothing wrong at all.
 *
 * Judged live, the panel was red from the first feed row to the last output of every
 * single shift. A control that is always red is not a control; the operator learns within
 * a week that the red box means "the shift is in progress" and then does not see the day
 * it means "five tonnes of lint are missing".
 *
 * So the yield and loss findings wait for the run to close. The one finding that does not
 * wait is `outputs-exceed-input` — more coming out than went in is impossible at any
 * moment of any shift, and it is never a matter of timing.
 */
export type RunStage = "open" | "closed";

export function massBalance(
  totals: RunTotals,
  norms: YieldNorms = DEFAULT_YIELD_NORMS,
  stage: RunStage = "closed",
): MassBalance {
  const feedG = assertNonNegativeInt(totals.feedG, "feedG");
  const recycledG = assertNonNegativeInt(totals.recycledG, "recycledG");

  // Recycled улюк is real mass through the machines, so it belongs on the input side of
  // the arithmetic — but never in the denominator of a yield, where it would make the
  // factory look as though it had produced lint from nothing.
  const inputG = feedG + recycledG;
  const outputG = totals.chigitG + totals.kipG + totals.ulyukG + totals.puchoqG;
  const lossG = inputG - outputG;

  const findings: MassBalanceFinding[] = [];

  /*
   * Outputs with nothing recorded going in. An alarm, and the reason this module exists.
   *
   * Only once there *are* outputs, though. A run that has just been opened has no feed
   * and no outputs, and raising this on it puts a red box on the gin floor from the
   * moment of the first click every single shift — which is how an operator learns that
   * the red box means nothing. Nothing recorded is not a finding; it is an empty run.
   */
  if (stage === "closed" && feedG === 0 && outputG > 0) {
    findings.push({
      code: "no-feed",
      severity: "alarm",
      titleTg: "Вазни пахтаи фиристодашуда сабт нашудааст",
      detail:
        "Outputs are recorded but no cotton was logged as fed in, so nothing can be " +
        "checked against them.",
    });
  }

  // More out than in. Not a tolerance question — mass does not appear.
  if (lossG < 0) {
    findings.push({
      code: "outputs-exceed-input",
      severity: "alarm",
      titleTg: "Маҳсулот аз пахтаи фиристодашуда зиёд аст",
      detail:
        `Outputs total ${outputG} g against ${inputG} g fed in — ` +
        `${-lossG} g more came out than went in.`,
    });
  }

  const lossBp = bp(Math.max(0, lossG), inputG);
  if (stage === "closed" && feedG > 0 && lossG > 0 && lossBp > norms.maxLossBp) {
    findings.push({
      code: "loss-too-high",
      severity: "alarm",
      titleTg: "Талафот аз меъёр зиёд аст",
      detail:
        `${(lossBp / 100).toFixed(2)} % unaccounted for, against a limit of ` +
        `${(norms.maxLossBp / 100).toFixed(2)} %.`,
    });
  }

  const chigitBp = bp(totals.chigitG, feedG);
  const kipBp = bp(totals.kipG, feedG);

  // Proportion checks catch what the total cannot: bales weighed light put the missing
  // lint into "loss", and the sum still adds up.
  if (stage === "closed" && feedG > 0 &&
      (chigitBp < norms.chigitBp.min || chigitBp > norms.chigitBp.max)) {
    findings.push({
      code: "chigit-out-of-range",
      severity: "warn",
      titleTg: "Ҳосили чигит аз меъёр берун аст",
      detail:
        `Seed yield ${(chigitBp / 100).toFixed(2)} %, expected ` +
        `${(norms.chigitBp.min / 100).toFixed(0)}–${(norms.chigitBp.max / 100).toFixed(0)} %.`,
    });
  }

  if (stage === "closed" && feedG > 0 &&
      (kipBp < norms.kipBp.min || kipBp > norms.kipBp.max)) {
    findings.push({
      code: "kip-out-of-range",
      severity: "warn",
      titleTg: "Ҳосили кип аз меъёр берун аст",
      detail:
        `Lint yield ${(kipBp / 100).toFixed(2)} %, expected ` +
        `${(norms.kipBp.min / 100).toFixed(0)}–${(norms.kipBp.max / 100).toFixed(0)} %. ` +
        `Light bale weights show up here before they show up anywhere else.`,
    });
  }

  const severity: MassBalanceSeverity = findings.some((f) => f.severity === "alarm")
    ? "alarm"
    : findings.length > 0
      ? "warn"
      : "ok";

  return {
    feedG,
    recycledG,
    outputG,
    lossG,
    lossBp,
    chigitBp,
    kipBp,
    ulyukBp: bp(totals.ulyukG, feedG),
    puchoqBp: bp(totals.puchoqG, feedG),
    findings,
    severity,
    final: stage === "closed",
  };
}
