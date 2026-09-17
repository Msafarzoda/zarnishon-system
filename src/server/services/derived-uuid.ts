import { createHash } from "node:crypto";

/**
 * A derived, still-unique UUID for one of the several writes an operation makes.
 *
 * Settling a farm posts a payment per борхат and one disbursement under a single request;
 * selling a lorry posts the sale and, if it was paid on the spot, the receipt. Each row
 * needs its own idempotency key, and they are **derived** from the request's key rather
 * than generated, so a replay after a timeout finds every row already written — a fresh
 * key per attempt would do the work a second time.
 *
 * Hashed rather than built by editing hex digits in place: an operation can have any
 * number of parts, and an index poked into one nibble quietly caps it at fifteen.
 */
export function derivedUuid(base: string, label: string): string {
  const h = createHash("sha256").update(`${base}:${label}`).digest("hex");
  // Stamped as a v8 UUID — "custom", which is exactly what this is.
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-` +
    `${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
  );
}
