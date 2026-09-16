import { CR, ETX, STX } from "@/domain/scale";

/**
 * Cuts a serial byte stream into whole frames.
 *
 * The port delivers arbitrary chunks — a frame can arrive split across two reads, or two
 * frames in one. Handing a half-frame to the parser is how an indicator reading 3015
 * becomes a weighing of 301, so nothing is emitted until a frame is complete.
 *
 * Three shapes are handled:
 *
 *   STX … ETX   the Keli D2008 on this weighbridge — twelve bytes, checksum inside
 *   STX … CR    the Toledo continuous frame, with an optional checksum byte after CR
 *   … CR/LF     plain lines of text
 *
 * STX opens the first two, so which one it is cannot be known until the terminator turns
 * up. Whichever comes first wins, and a frame is never emitted until it is complete.
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
      const etx = this.buffer.indexOf(String.fromCharCode(ETX), stx);
      const cr = this.buffer.indexOf(String.fromCharCode(CR), stx);

      /*
       * The Keli frame this weighbridge sends ends at ETX and carries its checksum
       * inside, so there is nothing to wait for after it. Taken when ETX arrives first —
       * a Toledo frame's CR would otherwise be looked for and never found here, and the
       * buffer would fill with whole frames nobody read.
       */
      if (etx !== -1 && (cr === -1 || etx < cr)) {
        const frame = this.buffer.slice(stx, etx + 1);
        this.buffer = this.buffer.slice(etx + 1);
        return frame;
      }

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
