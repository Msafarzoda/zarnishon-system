/**
 * A stand-in Keli D2008, writing real frames down a real serial port.
 *
 * For commissioning the *server-side* reader without a weighbridge: pair two pseudo-ttys
 * with socat, point this at one end and SCALE_PORT at the other, and the whole path —
 * port, framer, parser, settling, capture — runs exactly as it will with the indicator.
 *
 *   socat pty,raw,echo=0,link=/tmp/indicator pty,raw,echo=0,link=/tmp/server &
 *   npx tsx scripts/fake-indicator.ts /tmp/indicator 3015
 */
import { SerialPort } from "serialport";
import { encodeKeliFrame } from "../src/domain/scale";
import { simulatedReading } from "../src/lib/scale/simulator";

const path = process.argv[2];
const targetKg = Number(process.argv[3] ?? 3015);
if (!path) {
  console.error("usage: tsx scripts/fake-indicator.ts <port> [kg]");
  process.exit(1);
}

const port = new SerialPort({ path, baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" });
const startedAt = Date.now();

port.on("open", () => {
  console.log(`Индикатори сунъӣ / fake indicator on ${path} → ${targetKg} кг`);
  // Real indicators stream several times a second; this matches that.
  setInterval(() => {
    const { displayedKg } = simulatedReading(targetKg, Date.now() - startedAt);
    port.write(encodeKeliFrame(displayedKg));
  }, 200);
});

port.on("error", (e) => {
  console.error("fake indicator:", e.message);
  process.exit(1);
});
