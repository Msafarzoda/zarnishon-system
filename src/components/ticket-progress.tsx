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

type StepState = "done" | "next" | "todo";

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

  const steps: { label: string; value?: string; done: boolean }[] = [
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
    { label: tg.ticket.paidStep, done: paid },
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
      <span aria-hidden>{state === "done" ? "✓" : state === "next" ? "▸" : "○"}</span>
      <span>{label}</span>
      {value && <span className="tabular font-medium">{value}</span>}
    </span>
  );
}

/** What this ticket is waiting for, in words. Empty when it is complete. */
export function waitingFor(ticket: TicketStage): string | null {
  if (ticket.status === "VOID") return null;
  if (ticket.status === "PAID") return null;
  if (ticket.grossG === null) return tg.ticket.gross;
  if (ticket.tareG === null) return tg.ticket.tareShort;
  if (ticket.status !== "ANALYSED") return tg.lab.title;
  return tg.cash.readyToPayShort;
}
