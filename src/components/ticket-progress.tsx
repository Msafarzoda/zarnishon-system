import { gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";

/**
 * The life of a Борхат, on one line.
 *
 * A ticket is not finished when the truck leaves. It needs **Брутто**, then **Тара** —
 * which together give нетто — and then the **lab's** result, which decides how much of
 * that нетто is actually paid for. Only with all three is it complete and payable, and
 * the farmer can come for his money whenever he chooses after that.
 *
 * Shown wherever a ticket appears, so that anyone looking at one can see what it is still
 * waiting for without knowing the rules.
 */

export interface TicketStage {
  grossG: number | null;
  tareG: number | null;
  netG: number | null;
  /** ANALYSED or PAID means the lab has signed it off. */
  status: string;
}

/**
 * `ready` is not `next`.
 *
 * A complete ticket that has not been paid is not stuck and nobody is late. The farmer is
 * holding his stamped copy and waiting for a price he likes — the whole reason the system
 * lets him keep it. Showing that as an outstanding task would turn a deliberate decision
 * into a chase.
 */
type StepState = "done" | "next" | "ready" | "todo";

export function TicketProgress({
  ticket,
  size = "md",
}: {
  ticket: TicketStage;
  size?: "sm" | "md";
}) {
  const gross = ticket.grossG !== null;
  const tare = ticket.tareG !== null;
  const analysed = ticket.status === "ANALYSED" || ticket.status === "PAID";
  const paid = ticket.status === "PAID";
  const voided = ticket.status === "VOID";

  const steps: { label: string; value?: string; done: boolean; ready?: boolean }[] = [
    {
      label: tg.ticket.gross,
      value: gross ? `${gramsToKgString(ticket.grossG!, 1)} ${tg.common.kg}` : undefined,
      done: gross,
    },
    {
      label: tg.ticket.tareShort,
      value: tare ? `${gramsToKgString(ticket.tareG!, 1)} ${tg.common.kg}` : undefined,
      done: tare,
    },
    { label: tg.lab.title, done: analysed },
    // Payable the moment the lab signs off, and then it simply waits for the farmer.
    { label: tg.ticket.paidStep, done: paid, ready: analysed && !paid },
  ];

  // The first unfinished step is the one somebody has to do next.
  const nextIndex = steps.findIndex((s) => !s.done);

  return (
    <ol
      className={`flex flex-wrap items-center ${size === "sm" ? "gap-x-1 gap-y-1" : "gap-x-1.5 gap-y-2"}`}
    >
      {steps.map((step, i) => {
        const state: StepState = voided
          ? "todo"
          : step.done
            ? "done"
            : step.ready
              ? "ready"
              : i === nextIndex
                ? "next"
                : "todo";
        return (
          <li key={step.label} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-ink-faint/50">
                ·
              </span>
            )}
            <Step state={state} label={step.label} value={step.value} size={size} />
          </li>
        );
      })}
    </ol>
  );
}

function Step({
  state, label, value, size,
}: { state: StepState; label: string; value?: string; size: "sm" | "md" }) {
  const style =
    state === "done"
      ? "bg-brand-light text-brand-dark border-brand/30"
      : state === "ready"
        ? "bg-white text-brand border-brand font-semibold"
        : state === "next"
          ? "bg-amber-100 text-warn border-warn/40 font-semibold"
          : "bg-paper text-ink-faint border-paper-line";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${style} ${
        size === "sm" ? "text-[11px]" : "text-xs"
      }`}
    >
      {/* Shape as well as colour, so the state survives a monochrome screen. */}
      <span aria-hidden>
        {state === "done" ? "✓" : state === "next" ? "▸" : state === "ready" ? "●" : "○"}
      </span>
      <span>{label}</span>
      {value && <span className="tabular font-medium">{value}</span>}
    </span>
  );
}

export interface TicketWaiting {
  label: string;
  /**
   * `false` when the ticket is complete and simply unpaid — the farm's decision, not a
   * task for the factory, and it must not be dressed up as one.
   */
  outstanding: boolean;
}

/** What this ticket is waiting for, in words. Null when there is nothing to say. */
export function waitingFor(ticket: TicketStage): TicketWaiting | null {
  if (ticket.status === "VOID" || ticket.status === "PAID") return null;
  if (ticket.grossG === null) return { label: tg.ticket.gross, outstanding: true };
  if (ticket.tareG === null) return { label: tg.ticket.tareShort, outstanding: true };
  if (ticket.status !== "ANALYSED") return { label: tg.lab.title, outstanding: true };
  return { label: tg.cash.readyToPayShort, outstanding: false };
}
