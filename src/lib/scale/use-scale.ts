"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeBytes,
  detectProtocol,
  diagnoseScale,
  isSettled,
  readFrame,
  type DetectedProtocol,
  type ScaleReading,
} from "@/domain/scale";
import { Framer } from "./framer";
import { runSimulator } from "./simulator";

/**
 * Live weight from the weighbridge indicator, read straight off the serial port by the
 * browser (Web Serial).
 *
 * The point is that **the operator never types a weight**. The number that reaches the
 * Борхат comes from the indicator, is marked `source: "indicator"`, and carries the raw
 * frame it came from. A serial-to-keyboard wedge would look similar and be worthless —
 * it types into whatever field has focus, so the operator can still type something else.
 *
 * Web Serial needs a secure context: https, or http://localhost. On the factory LAN that
 * means the server must serve https, which it should anyway.
 */

export type ScaleStatus =
  | "unsupported"
  | "disconnected"
  | "connecting"
  | "listening"
  | "streaming"
  | "error";

/** Why the port cannot be opened — the two causes need different answers. */
export type UnsupportedReason =
  /** The page is plain http on a LAN address. Browsers only allow serial on a
   *  secure origin: https, or http://localhost. */
  | "insecure-origin"
  /** The browser has no Web Serial at all — Safari, Firefox, or a phone. */
  | "no-web-serial";

export interface ScaleState {
  status: ScaleStatus;
  /** Set when `status` is "unsupported". */
  unsupportedReason: UnsupportedReason | null;
  /** The origin the page was opened on, so the message can name it. */
  origin: string;
  /**
   * True while the readings are coming from the simulator rather than a real indicator.
   * A weighing taken in this state is never stored as `source: "indicator"` — forging
   * scale data would defeat the entire point of wiring the scale in.
   */
  simulated: boolean;
  /** Most recent reading, whether settled or not. */
  reading: ScaleReading | null;
  /** True once the platform has held still long enough to capture. */
  settled: boolean;
  /**
   * The settled reading, held until the load actually changes.
   *
   * A real indicator's stable flag flickers: it settles, a gust or a shifting load knocks
   * it out for one frame, it settles again. Reading `settled` live meant the capture
   * button enabled and disabled under the operator's finger, and a press could land in a
   * gap and do nothing at all — which looks exactly like a broken screen.
   *
   * So the first settled reading is latched and kept. It is released only when the weight
   * moves far enough to be a different load, or after a capture.
   */
  held: ScaleReading | null;
  /** What the stream was identified as, shown during setup. */
  detected: DetectedProtocol | null;
  /** Last few raw frames, so a human can check the port against the indicator display. */
  frames: string[];

  /**
   * Byte-level evidence, for the moment somebody has just wired the cable up and wants to
   * know whether the indicator is saying anything at all.
   *
   * "No weight on screen" has four completely different causes — dead cable, wrong port,
   * wrong baud rate, unrecognised format — and they are indistinguishable without these.
   * A port that is open and silent looks exactly like a port carrying perfect frames
   * nobody can parse, and the fixes have nothing in common.
   */
  bytesReceived: number;
  /** Whole frames the framer has cut out of the stream. */
  framesCut: number;
  /** Frames that produced a weight. */
  readingsParsed: number;
  /** When the last byte arrived, so a stream that has stopped can be told from one that never started. */
  lastByteAt: number | null;
  /** The most recent bytes rendered readably — hex for anything unprintable. */
  rawSample: string;

  error: string | null;
}

const BAUD_RATE = 9600; // Keli D2008, continuous mode, 8N1
const HISTORY = 8;
/** Beyond this much movement the platform is carrying something else, not the same truck. */
const NEW_LOAD_G = 50_000;

export function useScale() {
  const [state, setState] = useState<ScaleState>({
    status: "disconnected",
    unsupportedReason: null,
    origin: "",
    simulated: false,
    reading: null,
    settled: false,
    held: null,
    detected: null,
    frames: [],
    bytesReceived: 0,
    framesCut: 0,
    readingsParsed: 0,
    lastByteAt: null,
    rawSample: "",
    error: null,
  });

  const counts = useRef({ bytes: 0, frames: 0, readings: 0 });
  const portRef = useRef<SerialPort | null>(null);
  const stopSimulator = useRef<(() => void) | null>(null);
  const stopRef = useRef(false);
  const recent = useRef<ScaleReading[]>([]);
  const sample = useRef<string[]>([]);
  const detectedRef = useRef<DetectedProtocol | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const origin = window.location.origin;

    // Distinguish the two failures. They look identical to the operator and have
    // completely different fixes: one is the address the page was opened on, the other
    // is the browser itself.
    if (!navigator.serial) {
      const reason: UnsupportedReason = window.isSecureContext
        ? "no-web-serial"
        : "insecure-origin";
      setState((s) => ({ ...s, status: "unsupported", unsupportedReason: reason, origin }));
      return;
    }
    setState((s) => ({ ...s, origin }));
  }, []);

  /** Everything a frame does to the screen, wherever the frame came from. */
  const ingest = useCallback((frame: string) => {
    if (!detectedRef.current) {
      sample.current = [...sample.current, frame].slice(-12);
      const detected = detectProtocol(sample.current);
      if (!detected) {
        setState((s) => ({ ...s, status: "listening", frames: sample.current.slice(-HISTORY) }));
        return;
      }
      detectedRef.current = detected;
      setState((s) => ({ ...s, detected, status: "streaming" }));
    }

    const reading = readFrame(frame, detectedRef.current);
    if (!reading) return;
    counts.current.readings += 1;

    recent.current = [...recent.current, reading].slice(-HISTORY);
    const settled = isSettled(recent.current);

    setState((s) => {
      // Keep the settled reading unless this one is a different load altogether.
      const movedAway =
        s.held !== null && Math.abs(reading.weightG - s.held.weightG) > NEW_LOAD_G;
      const held = settled ? reading : movedAway ? null : s.held;

      return {
        ...s,
        status: "streaming",
        reading,
        settled,
        held,
        frames: [...s.frames, reading.raw].slice(-HISTORY),
        error: null,
      };
    });
  }, []);

  /** Forget the held weight after it has been captured, ready for the next truck. */
  const release = useCallback(() => {
    recent.current = [];
    setState((s) => ({ ...s, held: null, settled: false }));
  }, []);

  /**
   * Feed the screen from the simulator instead of a port, for testing the weighbridge
   * without the indicator. Frames go through the same framer and the same parser.
   */
  const simulate = useCallback(
    (targetKg: number) => {
      stopSimulator.current?.();
      detectedRef.current = null;
      sample.current = [];
      recent.current = [];
      setState((s) => ({
        ...s, simulated: true, status: "listening", reading: null, settled: false,
        held: null, frames: [], error: null,
      }));
      stopSimulator.current = runSimulator(targetKg, ingest);
    },
    [ingest],
  );

  const pump = useCallback(async (port: SerialPort) => {
    const framer = new Framer();
    stopRef.current = false;

    while (!stopRef.current && port.readable) {
      const reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stopRef.current) break;
          if (!value) continue;

          /*
           * Counted before anything is parsed. Bytes arriving is the one fact that
           * separates a dead cable from every other fault, and it holds even when not a
           * single frame can be made sense of.
           */
          counts.current.bytes += value.length;
          const sample = describeBytes([...value].slice(-48));
          const at = Date.now();

          const cut = framer.push(value);
          counts.current.frames += cut.length;

          setState((s) => ({
            ...s,
            bytesReceived: counts.current.bytes,
            framesCut: counts.current.frames,
            readingsParsed: counts.current.readings,
            lastByteAt: at,
            rawSample: sample,
          }));

          // Identify the indicator from its first frames rather than assuming.
          for (const frame of cut) ingest(frame);
        }
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "error",
          error: err instanceof Error ? err.message : "serial read failed",
        }));
        break;
      } finally {
        reader.releaseLock();
      }
    }
  }, [ingest]);

  const open = useCallback(
    async (port: SerialPort) => {
      setState((s) => ({ ...s, status: "connecting", error: null }));
      try {
        await port.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: "none" });
      } catch (err) {
        // Already open from a previous mount is fine; anything else is not.
        const message = err instanceof Error ? err.message : String(err);
        if (!/already open/i.test(message)) {
          setState((s) => ({ ...s, status: "error", error: message }));
          return;
        }
      }
      portRef.current = port;
      detectedRef.current = null;
      sample.current = [];
      recent.current = [];
      counts.current = { bytes: 0, frames: 0, readings: 0 };
      setState((s) => ({
        ...s,
        status: "listening",
        bytesReceived: 0, framesCut: 0, readingsParsed: 0, lastByteAt: null, rawSample: "",
      }));
      void pump(port);
    },
    [pump],
  );

  /** Asks the operator to pick the COM port. Needs a click — the browser requires it. */
  const connect = useCallback(async () => {
    stopSimulator.current?.();
    stopSimulator.current = null;
    setState((s) => ({ ...s, simulated: false }));
    if (!navigator.serial) {
      setState((s) => ({ ...s, status: "unsupported" }));
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await open(port);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The operator closed the chooser — not an error worth showing.
      if (/no port selected/i.test(message)) return;
      setState((s) => ({ ...s, status: "error", error: message }));
    }
  }, [open]);

  const disconnect = useCallback(async () => {
    stopSimulator.current?.();
    stopSimulator.current = null;
    stopRef.current = true;
    const port = portRef.current;
    portRef.current = null;
    recent.current = [];
    try {
      await port?.close();
    } catch {
      // Already gone.
    }
    setState((s) => ({
      ...s,
      status: "disconnected", simulated: false, reading: null, settled: false,
      held: null, detected: null, frames: [], error: null,
      bytesReceived: 0, framesCut: 0, readingsParsed: 0, lastByteAt: null, rawSample: "",
    }));
  }, []);

  // A port the operator approved once is reopened silently on every later visit, so the
  // weighbridge does not need setting up again at the start of each shift.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!navigator.serial) return;
      const ports = await navigator.serial.getPorts().catch(() => []);
      const port = ports[0];
      if (port && !cancelled && !portRef.current && !stopSimulator.current) await open(port);
    })();
    return () => {
      cancelled = true;
      stopRef.current = true;
      stopSimulator.current?.();
    };
  }, [open]);

  /*
   * Derived rather than stored: it is a reading of the evidence, and storing it would let
   * it drift out of step with the counters it is a reading of.
   */
  const diagnosis = diagnoseScale({
    portOpen: state.status === "listening" || state.status === "streaming",
    bytesReceived: state.bytesReceived,
    framesCut: state.framesCut,
    readingsParsed: state.readingsParsed,
  });

  return { ...state, diagnosis, connect, disconnect, simulate, release };
}
