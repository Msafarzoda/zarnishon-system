import { currentUser } from "@/lib/auth/session";
import { ensureScaleReader, getScaleSnapshot } from "@/server/scale/reader";

export const dynamic = "force-dynamic";

/**
 * The live weight, pushed.
 *
 * Server-sent events rather than a socket: the traffic is one-way, it survives a proxy,
 * and the browser reconnects on its own when the WiFi drops — which on a factory floor it
 * will. The reader is polled internally at the indicator's own rate; sending only on
 * change would leave a station that connected mid-silence with a blank screen.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new Response("NOT_AUTHORISED", { status: 401 });
  ensureScaleReader();

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(getScaleSnapshot())}\n\n`));
        } catch {
          if (timer) clearInterval(timer);
        }
      };
      send();
      timer = setInterval(send, 200);

      request.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer event streams into uselessness without this.
      "x-accel-buffering": "no",
    },
  });
}
