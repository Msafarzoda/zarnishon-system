import { DomainError } from "./units.js";

/**
 * Lifecycle of a Борхат (weigh ticket). See docs/domain.md §2 and §4.
 *
 *   DRAFT ──gross──▶ OPEN ──tare──▶ WEIGHED ──lab approved──▶ ANALYSED ──cash──▶ PAID
 *      └──────────────┴─────────────┴──────────────┴──── void (reason) ───▶ VOID
 *
 * A ticket only leaves ANALYSED once. PAID and VOID are terminal: a mistake after
 * that is corrected by a reversing entry, never by moving the ticket back.
 */
export const TICKET_STATUSES = [
  "DRAFT",
  "OPEN",
  "WEIGHED",
  "ANALYSED",
  "PAID",
  "VOID",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type TicketTransition =
  | "CAPTURE_GROSS"
  | "CAPTURE_TARE"
  | "APPROVE_ANALYSIS"
  | "PAY"
  | "VOID";

const TRANSITIONS: Record<TicketTransition, { from: TicketStatus[]; to: TicketStatus }> = {
  CAPTURE_GROSS: { from: ["DRAFT"], to: "OPEN" },
  CAPTURE_TARE: { from: ["OPEN"], to: "WEIGHED" },
  APPROVE_ANALYSIS: { from: ["WEIGHED"], to: "ANALYSED" },
  PAY: { from: ["ANALYSED"], to: "PAID" },
  VOID: { from: ["DRAFT", "OPEN", "WEIGHED", "ANALYSED"], to: "VOID" },
};

export const TERMINAL_STATUSES: readonly TicketStatus[] = ["PAID", "VOID"];

export function canTransition(from: TicketStatus, transition: TicketTransition): boolean {
  return TRANSITIONS[transition].from.includes(from);
}

/**
 * Returns the resulting status, or throws with a message an operator can act on.
 * This is the single place that decides whether a ticket may move — the HTTP layer,
 * the offline queue and the batch-approval job all go through it.
 */
export function transition(from: TicketStatus, t: TicketTransition): TicketStatus {
  const rule = TRANSITIONS[t];
  if (!rule.from.includes(from)) {
    if (t === "PAY" && from === "PAID") {
      throw new DomainError(
        "Ин борхат аллакай пардохт шудааст. / This ticket has already been paid.",
      );
    }
    if (t === "PAY" && from === "WEIGHED") {
      throw new DomainError(
        "Таҳлили лаборатория тасдиқ нашудааст. / Lab analysis for this batch is not approved yet.",
      );
    }
    if (from === "VOID") {
      throw new DomainError("Ин борхат бекор карда шудааст. / This ticket has been voided.");
    }
    throw new DomainError(
      `Cannot ${t} a ticket in status ${from} (allowed from: ${rule.from.join(", ")}).`,
    );
  }
  return rule.to;
}

/** Gate register states the guard sees — derived from the ticket, not stored twice. */
export const GATE_STATES = [
  "ARRIVED",
  "WEIGHED_GROSS",
  "UNLOADING",
  "WEIGHED_TARE",
  "DEPARTED",
] as const;

export type GateState = (typeof GATE_STATES)[number];
