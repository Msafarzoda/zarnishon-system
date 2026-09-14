/**
 * Minimal Web Serial typings.
 *
 * Declared here rather than pulled from a package: the factory installs over a slow,
 * intermittent line and every dependency is one more thing that has to arrive.
 */
interface SerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  bufferSize?: number;
  flowControl?: "none" | "hardware";
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  addEventListener(type: "disconnect", listener: () => void): void;
  removeEventListener(type: "disconnect", listener: () => void): void;
}

interface Serial {
  getPorts(): Promise<SerialPort[]>;
  requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPort>;
  addEventListener(type: "connect" | "disconnect", listener: () => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: () => void): void;
}

interface Navigator {
  readonly serial?: Serial;
}
