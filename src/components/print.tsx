import type { ReactNode } from "react";
import { tg } from "@/lib/i18n/tg";

/**
 * The printed documents: Борхат, Форма №9-хл, Ҳисобномаи пардохт.
 *
 * All three are the same object — a factory form in three copies on one A4 sheet, cut
 * apart. They share this layout so they look like one system's paperwork rather than
 * three, and so the print geometry is fixed in one place: each copy gets a 92 mm slot,
 * three come to 276 mm, and the page has 285 mm.
 *
 * They are also read beside the handwritten book while both are being kept, so every
 * copy carries its own identity: the form code, the season, the партия and the system's
 * own serial.
 */

export const FACTORY = "ЧДММ «ЗАРНИШОН»";

/**
 * The A4 sheet the copies are cut from.
 *
 * `copies` decides how tall each one is: three of them share the page on a Борхат, but a
 * cash receipt only needs two — and left at a third of the page each, two copies printed
 * small on a mostly blank sheet. The height is set here rather than in each copy so that
 * the arithmetic (copies × height ≤ the 285 mm inside A4's margins) stays in one place.
 */
export function PrintSheet({
  children, copies = 3,
}: { children: ReactNode; copies?: 2 | 3 }) {
  return (
    <div
      className={`borkhat-sheet sheet-of-${copies} mx-auto max-w-[210mm] space-y-4 px-4`}
    >
      {children}
    </div>
  );
}

export function PrintPage({ children }: { children: ReactNode }) {
  return <div className="borkhat-page min-h-screen bg-paper py-6">{children}</div>;
}

export function PrintCopy({
  formCode, title, serialLabel, serialValue, right, copyLabel, cutAbove, children,
}: {
  /** e.g. "Шакли махсус №1-(пахта)" */
  formCode: string;
  title: string;
  /** The big number on the form, e.g. "№" + 46. */
  serialLabel?: string;
  serialValue?: string | number;
  /** Season / партия line. */
  right?: ReactNode;
  copyLabel: string;
  /** The system serial, printed small so paper can be matched to the book. */
  cutAbove: boolean;
  children: ReactNode;
}) {
  return (
    <article className="print-copy card relative bg-white p-4 text-[12px] leading-snug">
      {cutAbove && (
        <span className="absolute -top-2 left-3 bg-paper px-1 text-[10px] text-ink-faint print:bg-white">
          ✂ {tg.ticket.cutHere}
        </span>
      )}

      <header className="mb-2 flex items-start justify-between gap-3 border-b-2 border-ink pb-1.5">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">{formCode}</div>
          <h2 className="font-bold uppercase leading-tight tracking-wide">
            {title}
            {serialValue !== undefined && (
              <>
                {serialLabel && <span className="ms-2 font-normal">{serialLabel}</span>}
                <span className="ms-1 font-mono text-base">{serialValue}</span>
              </>
            )}
          </h2>
          <div className="text-[10px] text-ink-soft">{FACTORY}</div>
        </div>
        <div className="shrink-0 text-end">
          {right}
          <div className="mt-0.5 inline-block border border-ink-faint px-1.5 py-0.5 font-semibold">
            {copyLabel}
          </div>
        </div>
      </header>

      {children}
    </article>
  );
}

/** Season · партия · system serial, the line every copy carries top-right. */
export function PrintIdentity({
  season, batchNumber, serial,
}: { season: number; batchNumber: number | null; serial: string }) {
  return (
    <>
      <div className="text-[10px] text-ink-faint">
        {tg.app.season}-{season} · {tg.ticket.batch}{" "}
        <strong className="text-ink">{batchNumber ?? "—"}</strong>
      </div>
      <div className="font-mono text-[9px] text-ink-faint">{serial}</div>
    </>
  );
}

/** Two-column block of labelled values, the way the paper form reads. */
export function PrintFields({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-5">{children}</div>;
}

export function PrintField({
  label, value,
}: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex gap-2 border-b border-dotted border-paper-line py-px">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="ms-auto truncate text-end font-medium">
        {value === null || value === undefined || value === "" ? "—" : value}
      </span>
    </div>
  );
}

/** Signature lines. Two or three across the foot of the copy. */
export function PrintSignatures({ children }: { children: ReactNode }) {
  return <div className="mt-3 grid auto-cols-fr grid-flow-col gap-4 text-[9px]">{children}</div>;
}

export function PrintSignature({ label, name }: { label: string; name?: string | null }) {
  return (
    <div>
      <div className="h-5 border-b border-ink" />
      <div className="mt-0.5 text-ink-faint">{label}</div>
      <div className="font-medium">{name ?? " "}</div>
    </div>
  );
}

/** A bordered notice at the foot of a copy — the driver's "keep this paper" warning. */
export function PrintWarning({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 border border-alarm bg-red-50 px-2 py-1 text-[10px] font-semibold text-alarm">
      {children}
    </p>
  );
}

export function PrintNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 border border-warn/50 bg-amber-50 px-2 py-0.5 text-[10px] text-warn">
      {children}
    </p>
  );
}
