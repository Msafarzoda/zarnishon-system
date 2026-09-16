"use client";

import { useEffect, useRef, useState } from "react";
import type { ScaleDiagnosis, ScaleReading, DetectedProtocol } from "@/domain/scale";

/**
 * The weight the **server** is reading, streamed to this screen.
 *
 * Deliberately the same shape as `useScale`, the browser-side reader, so a screen can take
 * either without knowing which. The difference that matters is invisible here and total:
 * with this one the page never touches a serial port and never supplies a number — it asks
 * the server to capture, and the server records what it is reading itself.
 *
 * Server-sent events, with a poll as the fallback. On a factory WiFi the connection will
 * drop; EventSource reconnects on its own, and the poll covers anything that blocks event
 * streams outright.
 */
export interface ServerScaleState {
  connected: boolean;
  path: string | null;
  diagnosis: ScaleDiagnosis;
  reading: ScaleReading | null;
  settled: boolean;
  held: ScaleReading | null;
  detected: DetectedProtocol | null;
  bytesReceived: number;
  framesCut: number;
  readingsParsed: number;
  lastByteAt: number | null;
  stale: boolean;
  rawSample: string;
  frames: string[];
  error: string | null;
  /** Whether this screen is receiving the stream at all — distinct from the scale itself. */
  live: boolean;
}

const EMPTY: ServerScaleState = {
  connected: false,
  path: null,
  diagnosis: "not-connected",
  reading: null,
  settled: false,
  held: null,
  detected: null,
  bytesReceived: 0,
  framesCut: 0,
  readingsParsed: 0,
  lastByteAt: null,
  stale: false,
  rawSample: "",
  frames: [],
  error: null,
  live: false,
};

export function useServerScale(): ServerScaleState {
  const [state, setState] = useState<ServerScaleState>(EMPTY);
  const live = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const apply = (snapshot: unknown) => {
      if (cancelled) return;
      live.current = true;
      setState({ ...(snapshot as Omit<ServerScaleState, "live">), live: true });
    };

    try {
      source = new EventSource("/api/scale/stream");
      source.onmessage = (e) => apply(JSON.parse(e.data));
      source.onerror = () => {
        // EventSource retries by itself; the screen only needs to stop claiming it is live.
        live.current = false;
        if (!cancelled) setState((s) => ({ ...s, live: false }));
      };
    } catch {
      source = null;
    }

    // Covers the case where event streams are blocked outright, and fills the gap while
    // EventSource is between retries.
    poll = setInterval(() => {
      if (live.current) return;
      void fetch("/api/scale/snapshot")
        .then((r) => (r.ok ? r.json() : null))
        .then((snapshot) => {
          if (snapshot && !cancelled) {
            setState({ ...(snapshot as Omit<ServerScaleState, "live">), live: true });
          }
        })
        .catch(() => undefined);
    }, 1000);

    return () => {
      cancelled = true;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  return state;
}
