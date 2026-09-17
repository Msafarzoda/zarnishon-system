import { code128Svg } from "@/lib/barcode/code128";
import { gramsToKgString } from "@/domain/units";
import { FACTORY } from "./print";

/**
 * Тамғаи кип — the label stapled to a bale.
 *
 * Читается by two different readers and has to satisfy both. A scanner at the loading
 * bay reads the barcode; a man standing in a shed reads the партия number, which is why
 * that is the largest thing on it and the serial is not.
 *
 * **The weight is printed but is not in the barcode**, and that is the whole design. A
 * barcode carrying the weight can be reprinted by anyone with a label printer, and a
 * 213 kg bale then scans as 180 at the loading bay with nothing to contradict it. The
 * scan carries the serial; the weight is looked up from the record it was written to at
 * the press. Same rule as §2 — the number comes from the record, never from something a
 * person can retype.
 */
export function BaleLabel({
  serial, weightG, batchNumber, grade, pressedAt,
}: {
  serial: string;
  weightG: number;
  batchNumber: number | null;
  grade: string | null;
  pressedAt: string;
}) {
  return (
    <article className="bale-label border border-ink/30 bg-white p-3 text-center">
      <div className="text-[10px] uppercase tracking-wide text-ink-soft">{FACTORY}</div>

      <div className="mt-1 flex items-baseline justify-center gap-3">
        <span className="text-[11px] text-ink-soft">ПАРТИЯ</span>
        <span className="text-4xl font-black leading-none tabular">{batchNumber ?? "—"}</span>
      </div>

      <div className="mt-2 tabular text-2xl font-bold leading-none">
        {gramsToKgString(weightG, 1)} <span className="text-base font-medium">кг</span>
      </div>

      <div
        className="mt-2 flex justify-center"
        // Generated markup, from our own encoder, with no user-supplied content in it:
        // the serial is built by the server from a season and two integers.
        dangerouslySetInnerHTML={{ __html: code128Svg(serial, { moduleWidth: 2, height: 48 }) }}
      />
      <div className="mt-1 font-mono text-[13px] tracking-tight">{serial}</div>

      <div className="mt-1 flex justify-between text-[10px] text-ink-faint">
        <span>{grade ? `Сорт ${grade}` : ""}</span>
        <span>
          {new Date(pressedAt).toLocaleDateString("ru-RU", {
            day: "2-digit", month: "2-digit", year: "numeric",
          })}
        </span>
      </div>
    </article>
  );
}
