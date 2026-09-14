import type { ReactNode } from "react";
import { tg } from "@/lib/i18n/tg";

/**
 * Shared building blocks, so every screen states the same things the same way.
 *
 * These run on a factory floor: read standing up, often on an old monitor, sometimes
 * with gloves on a tablet. Numbers are large and tabular so a column can be scanned;
 * state is colour AND words, never colour alone; and nothing important is smaller than
 * the surrounding text.
 */

export function Section({
  title, subtitle, actions, children, tone, scroll,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  tone?: "warn" | "alarm";
  scroll?: boolean;
}) {
  const border =
    tone === "alarm" ? "border-alarm bg-red-50/60" : tone === "warn" ? "border-warn bg-amber-50/50" : "";
  return (
    <section className={`card ${border} ${scroll ? "overflow-x-auto" : ""} p-4 sm:p-5`}>
      {(title || actions) && (
        <header className="mb-3 flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            {title && (
              <h2
                className={`text-sm font-semibold ${
                  tone === "alarm" ? "text-alarm" : tone === "warn" ? "text-warn" : "text-ink-soft"
                }`}
              >
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** A headline figure. `accent` marks the one number the screen exists to show. */
export function Stat({
  label, value, unit, hint, accent, tone, size = "md",
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  accent?: boolean;
  tone?: "warn" | "alarm";
  size?: "md" | "lg";
}) {
  return (
    <div className={`card px-4 py-3 ${accent ? "border-brand bg-brand-light" : ""}`}>
      <div className={`text-sm ${accent ? "text-brand-dark" : "text-ink-soft"}`}>{label}</div>
      <div
        className={`tabular font-bold leading-tight ${size === "lg" ? "text-3xl" : "text-2xl"} ${
          tone === "alarm"
            ? "text-alarm"
            : tone === "warn"
              ? "text-warn"
              : accent
                ? "text-brand-dark"
                : "text-ink"
        }`}
      >
        {value}
        {unit && <span className="ms-1 text-base font-medium text-ink-soft">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "bg-paper text-ink-soft",
  OPEN: "bg-sky-100 text-sky-900",
  WEIGHED: "bg-amber-100 text-warn",
  ANALYSED: "bg-brand-light text-brand-dark",
  PAID: "bg-brand text-white",
  VOID: "bg-red-100 text-alarm line-through",
};

/** A ticket's stage, always as colour plus the Tajik word. */
export function StatusBadge({ status }: { status: string }) {
  const label = tg.ticketStatus[status as keyof typeof tg.ticketStatus] ?? status;
  return (
    <span className={`badge ${STATUS_STYLE[status] ?? "bg-paper text-ink-soft"}`}>{label}</span>
  );
}

/**
 * An empty list should say why it is empty. "Nothing found" on its own is
 * indistinguishable from a broken screen, which is how an operator loses trust in it.
 */
export function Empty({ title, hint, tone }: { title: string; hint?: ReactNode; tone?: "warn" }) {
  return (
    <div className="card p-10 text-center">
      <p className="text-ink-faint">{title}</p>
      {hint && (
        <p className={`mt-2 text-sm ${tone === "warn" ? "text-warn" : "text-ink-soft"}`}>{hint}</p>
      )}
    </div>
  );
}

/** A message after an action: what happened, in the operator's language. */
export function Notice({
  tone, children,
}: { tone: "ok" | "warn" | "bad"; children: ReactNode }) {
  const style =
    tone === "ok"
      ? "border-brand bg-brand-light text-brand-dark"
      : tone === "warn"
        ? "border-warn bg-amber-50 text-warn"
        : "border-alarm bg-red-50 text-alarm";
  return (
    <div role="status" className={`card px-4 py-3 font-medium ${style}`}>
      {children}
    </div>
  );
}

/** Table header cell. `align="end"` for anything numeric. */
export function Th({
  children, align = "start", className = "",
}: { children?: ReactNode; align?: "start" | "end"; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap px-2 py-2 text-${align} text-xs font-medium uppercase tracking-wide text-ink-faint ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children, align = "start", className = "", numeric,
}: {
  children?: ReactNode;
  align?: "start" | "end";
  className?: string;
  numeric?: boolean;
}) {
  return (
    <td className={`px-2 py-2 text-${align} ${numeric ? "tabular" : ""} ${className}`}>
      {children}
    </td>
  );
}

/** Rows separated and hover-highlighted, so the eye keeps its place across a wide table. */
export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-paper-line [&>tr:hover]:bg-paper">{children}</tbody>;
}
