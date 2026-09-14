import { CR, STX } from "@/domain/scale";

/**
 * A stand-in for the Keli D2008, for testing without the weighbridge.
 *
 * It emits the **same frames the real indicator emits**, through the same framer and the
 * same parser, so what is exercised is the actual reading path and not a shortcut around
 * it. It also reproduces the behaviour that matters most: a truck driving on overshoots,
 * bounces on its springs, and only settles after a few seconds — which is exactly the
 * window in which a weight captured too early is wrong.
 *
 * A simulated weight is never recorded as coming from the indicator. See `useScale`.
 */

export function encodeToledoFrame(
  displayedKg: number,
  { decimals = 0, motion = false, over = false }: {
    decimals?: number; motion?: boolean; over?: boolean;
  } = {},
): string {
  const negative = displayedKg < 0;
  const magnitude = Math.round(Math.abs(displayedKg) * 10 ** decimals);
  const digits = String(Math.min(magnitude, 999_999)).padStart(6, "0");

  const swa = 0x20 | (decimals & 0x07);
  const swb = 0x20 | (negative ? 0x02 : 0) | (over ? 0x04 : 0) | (motion ? 0x08 : 0);
  const swc = 0x20;

  const body =
    String.fromCharCode(STX, swa, swb, swc) + digits + "000000" + String.fromCharCode(CR);

  let xor = 0;
  for (let i = 0; i < body.length; i++) xor ^= body.charCodeAt(i);
  return body + String.fromCharCode(xor & 0xff);
}

/**
 * The weight a truck shows over time as it drives onto the platform and settles.
 *
 * `elapsedMs` from the moment it rolled on. Overshoots, oscillates with decreasing
 * amplitude, and is declared stable roughly four seconds in — like the real thing.
 */
export function simulatedReading(
  targetKg: number,
  elapsedMs: number,
): { displayedKg: number; motion: boolean } {
  const SETTLE_MS = 4000;

  if (elapsedMs >= SETTLE_MS) {
    return { displayedKg: targetKg, motion: false };
  }

  const t = elapsedMs / SETTLE_MS;
  // Decaying oscillation around the true weight, plus a little noise on the last digit.
  const amplitude = targetKg * 0.02 * (1 - t) ** 2;
  const swing = Math.sin(elapsedMs / 180) * amplitude;
  const jitter = (Math.random() - 0.5) * 4;

  return { displayedKg: Math.round(targetKg + swing + jitter), motion: true };
}

/**
 * Drives a callback with simulated frames until stopped.
 * Real indicators stream several times a second; this matches that.
 */
export function runSimulator(
  targetKg: number,
  onFrame: (frame: string) => void,
  { intervalMs = 200 }: { intervalMs?: number } = {},
): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const { displayedKg, motion } = simulatedReading(targetKg, Date.now() - startedAt);
    onFrame(encodeToledoFrame(displayedKg, { motion }));
  }, intervalMs);
  return () => clearInterval(timer);
}
