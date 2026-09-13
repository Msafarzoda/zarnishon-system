"use client";

import { useEffect, useState } from "react";
import { pendingCount } from "@/lib/offline/outbox";
import { tg } from "@/lib/i18n/tg";

/**
 * Whether this station is talking to the server, and how much work is still queued
 * locally. An operator must be able to see at a glance that the gate is running on its
 * own — silence is the dangerous state.
 */
export function ConnectionBadge() {
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);

    let alive = true;
    const poll = async () => {
      try {
        const n = await pendingCount();
        if (alive) setQueued(n);
      } catch {
        // IndexedDB unavailable (private window) — the badge simply shows nothing queued.
      }
    };
    void poll();
    const timer = setInterval(poll, 4000);

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  if (online && queued === 0) {
    return (
      <span className="badge bg-white/15 text-white/85" title={tg.app.online}>
        ● {tg.app.online}
      </span>
    );
  }

  return (
    <span
      className={`badge ${online ? "bg-warn text-white" : "bg-alarm text-white"}`}
      title={online ? tg.app.pendingSync : tg.app.offline}
    >
      ● {online ? tg.app.pendingSync : tg.app.offline}
      {queued > 0 && <span className="ms-1 font-bold">{queued}</span>}
    </span>
  );
}
