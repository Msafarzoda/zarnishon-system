"use client";

import { useScale } from "@/lib/scale/use-scale";
import { ScaleCheck } from "@/components/scale-check";
import { gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";

/**
 * Connect, then watch. Nothing here writes anything anywhere — it is a diagnostic, and a
 * screen that could record a weight would invite somebody to record one while the port is
 * still being argued with.
 */
export function ScaleCheckClient() {
  const scale = useScale();

  return (
    <div className="space-y-4">
      {scale.status === "unsupported" ? (
        <section className="rounded-lg border border-alarm bg-red-50 p-4">
          <p className="font-medium text-alarm">
            {scale.unsupportedReason === "insecure-origin"
              ? tg.scale.insecureOrigin
              : tg.scale.serialUnsupported}
          </p>
          <p className="mt-1 text-sm text-alarm/90">
            {scale.unsupportedReason === "insecure-origin"
              ? tg.scale.insecureOriginHint
              : tg.scale.serialUnsupportedHint}
          </p>
          <p className="mt-2 text-sm text-alarm/80">
            {tg.scale.currentAddress}: <span className="font-mono">{scale.origin || "—"}</span>
          </p>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void scale.connect()} className="btn-primary">
              {tg.scale.connectScale}
            </button>
            {(scale.status === "listening" || scale.status === "streaming") && (
              <button
                type="button"
                onClick={() => void scale.disconnect()}
                className="btn-secondary"
              >
                {tg.common.cancel}
              </button>
            )}
          </div>

          <ScaleCheck scale={scale} />

          {/* The number, plainly, next to the evidence — this is the comparison that
              decides whether anything else in the system can be trusted. */}
          {scale.reading && (
            <section className="card p-4">
              <div className="text-sm text-ink-soft">{tg.scale.compareNow}</div>
              <div className="tabular text-5xl font-bold leading-none">
                {gramsToKgString(scale.reading.weightG, 1)}
                <span className="ms-2 text-2xl font-medium">{tg.common.kg}</span>
              </div>
              <pre className="mt-2 overflow-x-auto rounded bg-paper px-2 py-1 font-mono text-[11px] text-ink-soft">
                {JSON.stringify(scale.reading.raw)}
              </pre>
            </section>
          )}

          {scale.error && (
            <p role="alert" className="card border-alarm bg-red-50 px-4 py-3 text-alarm">
              {scale.error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
