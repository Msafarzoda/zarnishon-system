"use client";

import { useEffect, useState } from "react";
import { useScale, type ScaleState } from "./use-scale";
import { useServerScale } from "./use-server-scale";

/**
 * The weight, from wherever this factory reads it.
 *
 * Two arrangements exist and the screen should not care which it has:
 *
 *   **The server holds the port** (SCALE_PORT set). Every station sees the same live
 *   weight over the network, any browser on any machine works, no certificate is needed,
 *   and — the part that matters — the station never supplies a number. It asks the server
 *   to capture and the server records what *it* is reading.
 *
 *   **The browser holds the port** (Web Serial). Each weighbridge PC reads its own
 *   indicator. Needs https and a recent Chrome, and the browser hands the server a weight
 *   which the server has to take on trust.
 *
 * The first is better on every count, so it wins whenever it is available. The browser
 * path stays because a factory may wire the scale to the station rather than the server,
 * and because it is what a laptop with the indicator plugged into it can still do.
 */
export type WeighbridgeSource = "server" | "browser" | "deciding";

export interface Weighbridge {
  /** Where the number is coming from, for the screen to say so honestly. */
  source: WeighbridgeSource;
  status: ScaleState["status"];
  reading: ScaleState["reading"];
  settled: boolean;
  held: ScaleState["held"];
  simulated: boolean;
  frames: string[];
  detected: ScaleState["detected"];
  unsupportedReason: ScaleState["unsupportedReason"];
  origin: string;
  error: string | null;
  connect: () => Promise<void>;
  simulate: (kg: number) => void;
  release: () => void;
}

export function useWeighbridge(): Weighbridge {
  const browser = useScale();
  const server = useServerScale();

  // Asked once: does this server hold a port at all? Until the answer is in, neither
  // panel is shown — a screen that offers "connect the scale" and then takes it away a
  // second later reads as broken.
  const [serverHasScale, setServerHasScale] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/scale/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { path?: string | null } | null) => {
        if (!cancelled) setServerHasScale(Boolean(s && s.path));
      })
      .catch(() => {
        if (!cancelled) setServerHasScale(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (serverHasScale === null) {
    return {
      source: "deciding",
      status: "connecting",
      reading: null,
      settled: false,
      held: null,
      simulated: false,
      frames: [],
      detected: null,
      unsupportedReason: null,
      origin: browser.origin,
      error: null,
      connect: async () => undefined,
      simulate: () => undefined,
      release: () => undefined,
    };
  }

  if (serverHasScale) {
    return {
      source: "server",
      // The stream being live is a different thing from the scale being connected, and
      // the operator needs the second one.
      status: server.stale
        ? "listening"
        : server.connected && server.reading
          ? "streaming"
          : server.connected
            ? "listening"
            : "disconnected",
      reading: server.reading,
      settled: server.settled,
      held: server.held,
      // Nothing the server reads is ever simulated; the simulator is a browser-side aid.
      simulated: false,
      frames: server.frames,
      detected: server.detected,
      unsupportedReason: null,
      origin: browser.origin,
      error: server.error,
      // There is nothing for the operator to connect: the server did it at boot.
      connect: async () => undefined,
      simulate: () => undefined,
      release: () => undefined,
    };
  }

  return {
    source: "browser",
    status: browser.status,
    reading: browser.reading,
    settled: browser.settled,
    held: browser.held,
    simulated: browser.simulated,
    frames: browser.frames,
    detected: browser.detected,
    unsupportedReason: browser.unsupportedReason,
    origin: browser.origin,
    error: browser.error,
    connect: browser.connect,
    simulate: browser.simulate,
    release: browser.release,
  };
}
