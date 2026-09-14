"use client";

import { useEffect } from "react";
import { setActor } from "@/lib/offline/outbox";

/**
 * Records which user is signed in on this tab.
 *
 * One browser serves a whole shift: the weigher signs out, the cashier signs in. The
 * offline queue lives in the browser, not in the session, so without this the cashier's
 * session would try to send the weigher's queued weighings, the server would refuse them
 * as the wrong role, and real work would be lost.
 */
export function ActorTag({ userId }: { userId: string }) {
  useEffect(() => {
    setActor(userId);
  }, [userId]);
  return null;
}
