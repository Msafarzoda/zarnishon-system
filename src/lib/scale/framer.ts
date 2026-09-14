import { CR, STX } from "@/domain/scale";

/**
 * Cuts a serial byte stream into whole frames.
 *
 * The port delivers arbitrary chunks — a frame can arrive split across two reads, or two
 * frames in one. Handing a half-frame to the parser is how an indicator reading 3015
 * becomes a weighing of 301, so nothing is emitted until a frame is complete.
 *
 * Two shapes are handled: the binary Toledo frame the Keli D2008 emits (STX … CR plus an
 * optional checksum byte) and plain lines ending in CR/LF.
 */
export class Framer {
  private buffer = "";

  /** Frames completed by this chunk, oldest first. */
  push(chunk: Uint8Array): string[] {
    for (const byte of chunk) this.buffer += String.fromCharCode(byte);

    // Runaway guard: a port speaking the wrong baud rate produces endless noise with no
    // frame boundary in it, and the buffer would grow without limit.
    if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-1024);

    const frames: string[] = [];
    for (;;) {
      const frame = this.take();
      if (frame === null) break;
      if (frame.trim().length > 0) frames.push(frame);
    }
    return frames;
  }

  private take(): string | null {
    const stx = this.buffer.indexOf(String.fromCharCode(STX));
    const nl = this.buffer.search(/[\r\n]/);

    // A binary frame, when STX comes before any line ending.
    if (stx !== -1 && (nl === -1 || stx < nl)) {
      const cr = this.buffer.indexOf(String.fromCharCode(CR), stx);
      if (cr === -1) return null;

      // The checksum byte follows CR. Wait one byte for it, unless the next frame has
      // already started — then this frame simply carried no checksum.
      const after = this.buffer.charCodeAt(cr + 1);
      const hasMore = this.buffer.length > cr + 1;
      if (!hasMore) return null;
      const end = after === STX ? cr + 1 : cr + 2;

      const frame = this.buffer.slice(stx, end);
      this.buffer = this.buffer.slice(end);
      return frame;
    }

    if (nl !== -1) {
      const frame = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      return frame;
    }

    return null;
  }

  reset(): void {
    this.buffer = "";
  }
}
