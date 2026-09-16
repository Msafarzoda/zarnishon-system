"use client";

import { useState } from "react";
import { gramsToKgString } from "@/domain/units";
import type { Weighbridge } from "@/lib/scale/use-weighbridge";
import type { ScaleReading } from "@/domain/scale";
import { tg } from "@/lib/i18n/tg";

/**
 * The same page on the machine that is serving it — `http://localhost:<port>` — which
 * browsers do treat as a secure origin, so the port can be opened there without https.
 */
function localhostEquivalent(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
    return `http://localhost${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

/** Only the Toledo frame reports capacity; other indicators simply never say so. */
function isOverCapacity(reading: ScaleReading | null): boolean {
  return reading !== null && "overCapacity" in reading && reading.overCapacity === true;
}

/**
 * The live indicator reading, and the weight the operator is about to commit.
 *
 * The number is shown large and is **not editable**. It comes off the serial port, and
 * the capture button stays disabled until the platform has settled — a loaded truck
 * rocks on its springs for several seconds after it stops, and whichever moment the
 * operator happened to press is otherwise what gets paid for.
 */
export function ScalePanel({
  scale,
  label,
  hint,
  onConnect,
  allowSimulation,
}: {
  scale: Weighbridge;
  label: string;
  hint: string;
  onConnect?: () => void;
  /** Testing without the indicator. Off in production. */
  allowSimulation?: boolean;
}) {
  const { status, reading, settled } = scale;

  // Only meaningful when this browser is the thing opening the port. With the server
  // reading the scale, https is irrelevant and saying otherwise sends somebody chasing a
  // certificate they do not need.
  if (status === "unsupported" && scale.source !== "server") {
    // The two causes look the same to an operator and have completely different fixes.
    const insecure = scale.unsupportedReason === "insecure-origin";
    const localhostUrl = localhostEquivalent(scale.origin);

    return (
      <div className="rounded-lg border border-warn bg-amber-50 p-4">
        <p className="font-medium text-warn">
          {insecure ? tg.scale.insecureOrigin : tg.scale.serialUnsupported}
        </p>
        <p className="mt-1 text-sm text-warn/90">
          {insecure ? tg.scale.insecureOriginHint : tg.scale.serialUnsupportedHint}
        </p>

        {insecure && (
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-warn/80">
              {tg.scale.currentAddress}:{" "}
              <span className="font-mono">{scale.origin || "—"}</span>
            </p>
            {localhostUrl && (
              <p className="text-warn/80">
                {tg.scale.openOnServer}:{" "}
                <a href={localhostUrl} className="font-mono font-semibold underline">
                  {localhostUrl}
                </a>
              </p>
            )}
          </div>
        )}

        {/* Without this the operator cannot even rehearse — which is what made this
            panel a dead end the first time. */}
        {allowSimulation && <SimulateControls scale={scale} />}
      </div>
    );
  }

  if (status === "disconnected" || status === "error") {
    // With the server holding the port there is nothing for an operator to press: the
    // question is whether the indicator is switched on and the cable is in, not whether
    // somebody clicked Connect.
    if (scale.source === "server") {
      return (
        <div className="rounded-lg border border-warn bg-amber-50 p-4">
          <p className="font-medium text-warn">{tg.scale.serverScaleDown}</p>
          <p className="mt-1 text-sm text-warn/90">{tg.scale.serverScaleDownHint}</p>
          {scale.error && <p className="mt-2 text-sm text-alarm">{scale.error}</p>}
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-paper-line bg-paper p-4">
        <p className="mb-3 font-medium">{tg.scale.notConnected}</p>
        {scale.error && <p className="mb-3 text-sm text-alarm">{scale.error}</p>}
        <button
          type="button"
          onClick={() => {
            void scale.connect();
            onConnect?.();
          }}
          className="btn-primary btn-lg w-full"
        >
          {tg.scale.connectScale}
        </button>
        {/* Offered exactly here: the moment connecting did not work is the moment somebody
            needs to see whether the indicator is saying anything at all. */}
        <a href="/tarozu/sanjish" className="mt-2 block text-center text-sm text-brand underline">
          {tg.scale.checkTitle}
        </a>
        {allowSimulation && <SimulateControls scale={scale} />}
      </div>
    );
  }

  const waiting = status === "connecting" || status === "listening";

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        settled ? "border-brand bg-brand-light" : "border-warn bg-amber-50"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-sm font-medium ${settled ? "text-brand-dark" : "text-warn"}`}>
          {label}
        </span>
        <span className={`badge ${settled ? "bg-brand text-white" : "bg-warn text-white"}`}>
          {waiting ? tg.scale.waitingForScale : settled ? tg.scale.stable : tg.scale.unstable}
        </span>
      </div>
      <p className={`-mt-0.5 text-sm ${settled ? "text-brand-dark/75" : "text-warn/80"}`}>
        {hint}
      </p>

      {/* Read-only by construction: there is no input here to type into. */}
      <div
        className={`tabular mt-1 text-5xl font-bold leading-none ${
          settled ? "text-brand-dark" : "text-warn"
        }`}
      >
        {reading ? gramsToKgString(reading.weightG, 1) : "—"}
        <span className="ms-2 text-2xl font-medium">{tg.common.kg}</span>
      </div>

      {isOverCapacity(reading) && (
        <p className="mt-2 text-sm font-medium text-alarm">{tg.scale.overCapacity}</p>
      )}

      {scale.simulated && (
        <p className="mt-2 border border-alarm bg-red-50 px-2 py-1 text-sm font-semibold text-alarm">
          {tg.scale.simulationWarning}
        </p>
      )}

      {allowSimulation && <SimulateControls scale={scale} />}

      <Diagnostics scale={scale} />
    </div>
  );
}

/**
 * The raw bytes coming off the port, and what the stream was identified as.
 *
 * This is for commissioning. The manual says "a short ASCII string with a checksum",
 * which describes several incompatible formats, so before a single truck is weighed
 * somebody compares these frames against the number on the indicator's own display. If
 * the weight here does not match the display, nothing else in the system can be trusted.
 */
function Diagnostics({ scale }: { scale: Weighbridge }) {
  const [open, setOpen] = useState(false);
  if (scale.frames.length === 0) return null;

  return (
    <details
      className="mt-3 border-t border-paper-line pt-2 text-xs"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-ink-faint hover:text-ink">
        {tg.scale.diagnostics}
        {scale.detected && (
          <span className="ms-2 font-medium">
            {scale.detected.kind === "keli"
              ? "Keli D2008"
              : scale.detected.kind === "toledo"
                ? "Toledo continuous"
                : scale.detected.protocol.id}
          </span>
        )}
      </summary>
      <p className="mt-1 text-ink-faint">{tg.scale.diagnosticsHint}</p>
      <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ink-soft">
        {scale.frames.map((frame, i) => (
          <li key={i} className="truncate">{frame}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Drive the screen from the simulator instead of a real indicator.
 *
 * This exists so the weighbridge can be rehearsed on a laptop with no scale attached —
 * and because the settling behaviour is the part people need to see before they trust the
 * capture button. It is off in production, and anything weighed while it runs is recorded
 * as hand-entered, never as a reading from the indicator.
 */
function SimulateControls({ scale }: { scale: Weighbridge }) {
  return (
    <div className="mt-3 border-t border-paper-line pt-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
        {tg.scale.simulation}
      </p>
      <div className="flex flex-wrap gap-2">
        {[3015, 2380, 4250, 635].map((kg) => (
          <button
            key={kg}
            type="button"
            onClick={() => scale.simulate(kg)}
            className="btn-secondary px-3 py-1 text-sm"
          >
            {kg} {tg.common.kg}
          </button>
        ))}
      </div>
    </div>
  );
}
