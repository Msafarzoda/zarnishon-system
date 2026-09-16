"use client";

import { useEffect, useState } from "react";
import type { ScaleDiagnosis } from "@/domain/scale";
import type { ScaleState } from "@/lib/scale/use-scale";
import { tg } from "@/lib/i18n/tg";

/**
 * Оё тарозу чизе мефиристад? — the screen for the moment somebody has just wired the
 * indicator to the PC.
 *
 * "No weight appears" has four causes that look identical and share no fix: nothing on the
 * wire, the wrong baud rate, an unrecognised format, or a port nobody opened. This shows
 * the evidence that tells them apart — bytes counted before anything is parsed, frames cut
 * before anything is understood — and names the likely cause in the operator's language.
 *
 * Bytes arriving is the single fact worth most here. It survives every other fault: the
 * format can be unknown and the baud rate wrong, and a non-zero byte count still proves
 * the cable, the port and the indicator's transmit side are all alive.
 */
const ADVICE: Record<ScaleDiagnosis, { title: string; fix: string; tone: Tone }> = {
  "not-connected": { title: tg.scale.dxNotConnected, fix: tg.scale.dxNotConnectedFix, tone: "idle" },
  "no-bytes": { title: tg.scale.dxNoBytes, fix: tg.scale.dxNoBytesFix, tone: "bad" },
  "bytes-no-frames": { title: tg.scale.dxBytesNoFrames, fix: tg.scale.dxBytesNoFramesFix, tone: "warn" },
  "frames-no-parse": { title: tg.scale.dxFramesNoParse, fix: tg.scale.dxFramesNoParseFix, tone: "warn" },
  streaming: { title: tg.scale.dxStreaming, fix: tg.scale.dxStreamingFix, tone: "ok" },
};

type Tone = "idle" | "ok" | "warn" | "bad";

const TONE: Record<Tone, string> = {
  idle: "border-paper-line bg-paper",
  ok: "border-brand bg-brand-light",
  warn: "border-warn bg-amber-50",
  bad: "border-alarm bg-red-50",
};

const TEXT: Record<Tone, string> = {
  idle: "text-ink-soft",
  ok: "text-brand-dark",
  warn: "text-warn",
  bad: "text-alarm",
};

export function ScaleCheck({ scale }: { scale: ScaleState & { diagnosis: ScaleDiagnosis } }) {
  const advice = ADVICE[scale.diagnosis];

  return (
    <section className={`rounded-lg border p-4 ${TONE[advice.tone]}`}>
      <h2 className={`text-sm font-semibold ${TEXT[advice.tone]}`}>{tg.scale.checkTitle}</h2>
      <p className={`mt-1 text-lg font-semibold ${TEXT[advice.tone]}`}>{advice.title}</p>
      <p className={`mt-1 text-sm ${TEXT[advice.tone]}/90`}>{advice.fix}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-current/10 pt-3 sm:grid-cols-4">
        <Fact label={tg.scale.bytesReceived} value={scale.bytesReceived.toLocaleString("ru-RU")} />
        <Fact label={tg.scale.framesCut} value={scale.framesCut.toLocaleString("ru-RU")} />
        <Fact label={tg.scale.readingsParsed} value={scale.readingsParsed.toLocaleString("ru-RU")} />
        <Fact label={tg.scale.lastByte} value={<Since at={scale.lastByteAt} />} />
      </dl>

      {/* The bytes themselves. At the wrong baud rate the stream is not text at all, and a
          renderer that printed only printable characters would show a convincing blank. */}
      {scale.rawSample && (
        <div className="mt-3">
          <div className="text-xs font-medium uppercase tracking-wide opacity-70">
            {tg.scale.rawBytes}
          </div>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/60 px-2 py-1 font-mono text-[11px] leading-snug">
            {scale.rawSample}
          </pre>
        </div>
      )}

      {scale.diagnosis === "streaming" && (
        <p className="mt-3 rounded border border-current/20 px-3 py-2 text-sm font-medium">
          {tg.scale.compareNow}
        </p>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs opacity-70">{label}</dt>
      <dd className="tabular text-lg font-semibold">{value}</dd>
    </div>
  );
}

/**
 * How long ago the last byte arrived, ticking. A stream that has stopped reads as a live
 * one on a static screen — the counter simply stands still and nobody notices.
 *
 * Measured in the browser after mounting: the server renders at one moment and hydrates at
 * another, and a clock that disagrees across the two makes React discard the render.
 */
function Since({ at }: { at: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (at === null) return <>—</>;
  const seconds = Math.floor((Date.now() - at) / 1000);
  if (seconds < 1) return <>{tg.scale.justNow}</>;
  return (
    <>
      {seconds} <span className="text-sm font-normal">{tg.scale.secondsAgo}</span>
    </>
  );
}
