import { SerialPort } from "serialport";
import {
  DEFAULT_KELI_DECIMALS,
  describeBytes,
  detectProtocol,
  diagnoseScale,
  isSettled,
  readFrame,
  type DetectedProtocol,
  type ScaleDiagnosis,
  type ScaleReading,
} from "@/domain/scale";
import { Framer } from "@/lib/scale/framer";

/**
 * Хониши тарозу дар сервер — the indicator read by the server, not by a browser.
 *
 * The cable goes into the machine that runs this process, and every station sees the same
 * live weight over the network. That is a better arrangement than each station reading its
 * own port, for three reasons:
 *
 *   1. **The weight never passes through a browser.** A station asks "capture it" and the
 *      server records what *it* is reading. There is no frame for a page to supply, so
 *      there is nothing to forge — which the Web Serial route could not say, because the
 *      browser hands the server a number and the server has to believe it.
 *   2. **No secure origin is needed.** Web Serial demands https; this demands nothing, so
 *      an old Windows PC, a phone, any browser at all can drive the weighbridge.
 *   3. **One port to set up, once**, in a process that outlives every tab.
 *
 * What it costs: the cable has to physically reach this machine. RS-232 at 9600 baud is
 * good for about 15 m on decent cable, which is the real limit on where the server sits.
 *
 * The framing and parsing are the same pure functions the browser path uses — the format
 * was worked out once and is not implemented twice.
 */

const BAUD_RATE = 9600;
const HISTORY = 8;
/** Beyond this much movement the platform is carrying something else, not the same truck. */
const NEW_LOAD_G = 50_000;
/** A stream that has said nothing for this long is treated as gone. */
const STALE_MS = 3_000;
const RECONNECT_MS = 2_000;

export interface ScaleSnapshot {
  /** Whether a port is currently open. */
  connected: boolean;
  /** The port this reader was told to open, e.g. /dev/tty.usbserial-1420. */
  path: string | null;
  diagnosis: ScaleDiagnosis;
  reading: ScaleReading | null;
  settled: boolean;
  /** The settled reading, latched until the load actually changes. */
  held: ScaleReading | null;
  detected: DetectedProtocol | null;
  bytesReceived: number;
  framesCut: number;
  readingsParsed: number;
  lastByteAt: number | null;
  /** True when bytes have stopped arriving — told apart from never having arrived. */
  stale: boolean;
  /**
   * Where the decimal point goes in the Keli frame's seven digits, from `SCALE_DECIMALS`.
   *
   * Reported so the commissioning screen can say it out loud. The frame does not carry
   * it, so it cannot be checked by the machine at all — only by a person putting a known
   * weight on the platform and comparing. Getting it wrong multiplies or divides every
   * weight in the factory by ten, silently, and it did: a 70 kg test weight read as 700.
   */
  decimals: number;
  rawSample: string;
  frames: string[];
  error: string | null;
}

interface ReaderState extends ScaleSnapshot {
  port: SerialPort | null;
  framer: Framer;
  recent: ScaleReading[];
  sample: string[];
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

/**
 * One reader per process, parked on `globalThis`.
 *
 * Next reloads modules in development and runs route handlers in its own registry; a
 * module-level variable would give the HTTP routes a different, empty reader from the one
 * holding the port — which looks exactly like a scale that has stopped sending.
 */
const KEY = Symbol.for("zarnishon.scale.reader");
type Holder = { [KEY]?: ReaderState };

function blank(): ReaderState {
  return {
    connected: false,
    path: null,
    decimals: configuredDecimals(),
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
    port: null,
    framer: new Framer(),
    recent: [],
    sample: [],
    timer: null,
    stopped: false,
  };
}

function state(): ReaderState {
  const g = globalThis as Holder;
  if (!g[KEY]) g[KEY] = blank();
  return g[KEY];
}

/**
 * `SCALE_DECIMALS`, or the resolution this factory's indicator actually uses.
 *
 * A separate setting rather than something detected, because the frame gives no evidence
 * either way — see `DEFAULT_KELI_DECIMALS` in src/domain/scale.ts. Anything unreasonable
 * falls back to the default rather than turning every weight on the site into nonsense.
 */
function configuredDecimals(): number {
  const raw = process.env.SCALE_DECIMALS;
  if (raw === undefined) return DEFAULT_KELI_DECIMALS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    console.warn(`[scale] SCALE_DECIMALS=${raw} is not 0–3; using ${DEFAULT_KELI_DECIMALS}.`);
    return DEFAULT_KELI_DECIMALS;
  }
  return n;
}

/** What a frame does to the reader, wherever it came from. */
function ingest(s: ReaderState, frame: string): void {
  if (!s.detected) {
    s.sample = [...s.sample, frame].slice(-12);
    const detected = detectProtocol(s.sample);
    if (!detected) return;
    s.detected = detected;
  }

  const reading = readFrame(frame, s.detected, { decimals: s.decimals });
  if (!reading) return;

  s.readingsParsed += 1;
  s.reading = reading;
  s.frames = [...s.frames, reading.raw].slice(-HISTORY);
  s.recent = [...s.recent, reading].slice(-HISTORY);

  // The Keli frame carries no motion bit, so stillness is the only evidence there is:
  // an exact match across the window, which at ~5 frames a second is about a second.
  s.settled = isSettled(s.recent, { toleranceG: 0 });

  const movedAway = s.held !== null && Math.abs(reading.weightG - s.held.weightG) > NEW_LOAD_G;
  s.held = s.settled ? reading : movedAway ? null : s.held;
}

/** Forget the latched weight after it has been captured, ready for the next truck. */
export function releaseHold(): void {
  const s = state();
  s.held = null;
  s.settled = false;
  s.recent = [];
}

export function getScaleSnapshot(): ScaleSnapshot {
  const s = state();
  const stale = s.lastByteAt !== null && Date.now() - s.lastByteAt > STALE_MS;

  return {
    connected: s.connected,
    path: s.path,
    diagnosis: diagnoseScale({
      portOpen: s.connected,
      bytesReceived: s.bytesReceived,
      framesCut: s.framesCut,
      readingsParsed: s.readingsParsed,
    }),
    // A stream that stopped must not leave a stale weight on screen looking live.
    reading: stale ? null : s.reading,
    settled: stale ? false : s.settled,
    held: stale ? null : s.held,
    detected: s.detected,
    bytesReceived: s.bytesReceived,
    framesCut: s.framesCut,
    readingsParsed: s.readingsParsed,
    lastByteAt: s.lastByteAt,
    stale,
    decimals: s.decimals,
    rawSample: s.rawSample,
    frames: s.frames,
    error: s.error,
  };
}

/** Every serial port this machine can see, for choosing one during setup. */
export async function listScalePorts(): Promise<
  { path: string; manufacturer: string | null }[]
> {
  const ports = await SerialPort.list();
  return ports
    // The built-in Bluetooth and debug consoles are never a weighbridge, and offering
    // them as candidates only invites somebody to pick one.
    .filter((p) => !/Bluetooth|debug-console/i.test(p.path))
    .map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? null }));
}

function openPort(s: ReaderState, path: string): void {
  const port = new SerialPort({
    path,
    baudRate: BAUD_RATE,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    autoOpen: false,
  });

  port.on("open", () => {
    s.connected = true;
    s.error = null;
    s.framer = new Framer();
  });

  port.on("data", (chunk: Buffer) => {
    // Counted before anything is parsed: bytes arriving is the one fact that separates a
    // dead cable from every other fault, and it holds even when nothing can be understood.
    s.bytesReceived += chunk.length;
    s.lastByteAt = Date.now();
    s.rawSample = describeBytes([...chunk].slice(-48));

    const cut = s.framer.push(new Uint8Array(chunk));
    s.framesCut += cut.length;
    for (const frame of cut) ingest(s, frame);
  });

  const drop = (message: string) => {
    s.connected = false;
    s.error = message;
    s.reading = null;
    s.settled = false;
    s.held = null;
    if (s.stopped) return;
    // The cable gets kicked, the adapter gets unplugged, the indicator is switched off at
    // night. None of those should need a person to restart anything.
    s.timer = setTimeout(() => openPort(s, path), RECONNECT_MS);
  };

  port.on("error", (err: Error) => drop(err.message));
  port.on("close", () => drop("port closed"));

  port.open((err) => {
    if (err) drop(err.message);
  });

  s.port = port;
  s.path = path;
}

/**
 * Open the indicator's port and keep it open. Safe to call more than once; a second call
 * for the same path does nothing.
 */
export function startScaleReader(path: string | undefined = process.env.SCALE_PORT): void {
  if (!path) return;
  const s = state();
  if (s.path === path && (s.connected || s.timer)) return;

  stopScaleReader();
  const fresh = state();
  fresh.stopped = false;
  fresh.bytesReceived = 0;
  fresh.framesCut = 0;
  fresh.readingsParsed = 0;
  fresh.detected = null;
  fresh.sample = [];
  fresh.recent = [];
  fresh.frames = [];
  openPort(fresh, path);
}

/**
 * Open the port if it is configured and not already open. Safe and cheap to call on every
 * request that touches the scale.
 *
 * Called from the routes rather than from a startup hook: Next compiles
 * `instrumentation.ts` for the edge runtime as well as node, and webpack traces the import
 * of a native addon there whatever runtime guard is written around it — the build then
 * fails on `stream`, which the edge runtime does not have. Route handlers are node-only,
 * so the import is only ever reached somewhere it can work.
 */
export function ensureScaleReader(): void {
  const path = process.env.SCALE_PORT;
  if (!path) return;
  const s = state();
  if (s.connected || s.timer) return;
  startScaleReader(path);
}

export function stopScaleReader(): void {
  const s = state();
  s.stopped = true;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  try {
    s.port?.close();
  } catch {
    // Already gone.
  }
  s.port = null;
  s.connected = false;
}
