"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { pending, rejected, type OutboxOperation } from "@/lib/offline/outbox";
import { drain } from "@/lib/offline/station-client";
import { tg } from "@/lib/i18n/tg";

/**
 * Whether this station is talking to the server, and what work is still sitting on the
 * device. An operator must be able to see at a glance that the gate is running on its
 * own — silence is the dangerous state.
 *
 * The badge opens: a number nobody can explain is worse than no number, so the queue
 * lists what is waiting and what the server refused, and can be retried by hand.
 */
export function ConnectionBadge() {
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState<OutboxOperation[]>([]);
  const [failed, setFailed] = useState<OutboxOperation[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setQueued(await pending());
      setFailed(await rejected());
    } catch {
      // IndexedDB unavailable (private window) — the badge simply shows nothing queued.
    }
  }, []);

  const flushNow = useCallback(async () => {
    setBusy(true);
    try {
      const result = await drain();
      await refresh();
      if (result.applied > 0) router.refresh();
    } catch {
      // Still offline. The queue keeps its place.
    } finally {
      setBusy(false);
    }
  }, [refresh, router]);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);

    // On load, put back anything an interrupted page left mid-send and try again.
    void flushNow();

    const timer = setInterval(() => {
      if (navigator.onLine) void flushNow();
      else void refresh();
    }, 20_000);

    return () => {
      clearInterval(timer);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [flushNow, refresh]);

  const clean = online && queued.length === 0 && failed.length === 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`badge ${
          clean
            ? "bg-white/15 text-white/85"
            : failed.length > 0 || !online
              ? "bg-alarm text-white"
              : "bg-warn text-white"
        }`}
        title={online ? tg.app.online : tg.app.offline}
      >
        ● {clean ? tg.app.online : online ? tg.app.pendingSync : tg.app.offline}
        {queued.length > 0 && <span className="ms-1 font-bold">{queued.length}</span>}
        {failed.length > 0 && <span className="ms-1 font-bold">!{failed.length}</span>}
      </button>

      {open && (
        <div className="absolute end-0 z-20 mt-2 w-80 rounded-lg border border-paper-line bg-white p-3 text-ink shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{tg.app.queueTitle}</span>
            <button onClick={flushNow} disabled={busy || !online} className="btn-secondary px-2 py-1 text-xs">
              {busy ? tg.common.loading : tg.app.sendNow}
            </button>
          </div>

          {queued.length === 0 && failed.length === 0 && (
            <p className="py-3 text-center text-sm text-ink-faint">{tg.app.queueEmpty}</p>
          )}

          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {queued.map((op) => (
              <li key={op.clientUuid} className="flex gap-2 border-b border-paper-line py-1">
                <span className="font-mono text-ink-soft">{label(op.operation)}</span>
                <span className="ms-auto text-ink-faint">
                  {new Date(op.clientTimestamp).toLocaleTimeString("ru-RU", {
                    hour: "2-digit", minute: "2-digit",
                  })}
                </span>
              </li>
            ))}
            {failed.map((op) => (
              <li key={op.clientUuid} className="border-b border-paper-line py-1">
                <div className="flex gap-2">
                  <span className="font-mono text-alarm">{label(op.operation)}</span>
                  <span className="ms-auto text-ink-faint">
                    {new Date(op.clientTimestamp).toLocaleTimeString("ru-RU", {
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                </div>
                {/* The server refused this on its merits. It will not be retried. */}
                <p className="text-alarm">{op.lastError}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "/api/weighings" -> "weighings", so the operator sees what kind of work is waiting. */
function label(operation: string): string {
  return operation.replace(/^\/api\//, "");
}
