"use client";

import {
  enqueue,
  flush,
  newClientUuid,
  pruneApplied,
  recoverInterrupted,
  setStatus,
  type OutboxOperation,
} from "./outbox";

export type SubmitOutcome<T> =
  | { kind: "applied"; result: T; clientUuid: string }
  | { kind: "queued"; clientUuid: string; reason: string }
  | { kind: "rejected"; clientUuid: string; message: string };

async function send(op: OutboxOperation): Promise<Response> {
  return fetch(op.operation, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(op.payload as object), clientUuid: op.clientUuid }),
  });
}

/**
 * Submit one operation from a station screen.
 *
 * The operation is written to the local outbox **before** anything is sent, so it
 * survives a dropped connection, a closed lid or a dead battery. Then we try the
 * server. If it answers, the screen gets the real result; if it does not, the operation
 * stays queued and the operator carries on — a truck on the weighbridge does not wait
 * for the internet.
 *
 * A 4xx means the server refused it on its merits (already paid, tare above gross), so
 * it is surfaced to the operator instead of being retried.
 */
export async function submit<T>(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<SubmitOutcome<T>> {
  const clientUuid = newClientUuid();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  await enqueue(endpoint, { ...payload, originatedOffline: offline }, clientUuid);

  if (offline) {
    return { kind: "queued", clientUuid, reason: "offline" };
  }

  try {
    const response = await send({
      clientUuid,
      operation: endpoint,
      payload: { ...payload, originatedOffline: false },
      status: "SENDING",
      clientTimestamp: new Date().toISOString(),
      attempts: 1,
    });

    if (response.ok) {
      const result = (await response.json()) as T;
      // Drain anything that queued up while the connection was down.
      await flush(send).catch(() => undefined);
      await setStatus(clientUuid, "APPLIED", { result });
      return { kind: "applied", result, clientUuid };
    }

    // The wrong person is signed in, or the session expired. Keep the work queued.
    if (response.status === 401 || response.status === 403) {
      return { kind: "queued", clientUuid, reason: "not signed in" };
    }

    if (response.status >= 400 && response.status < 500) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      await setStatus(clientUuid, "REJECTED", { lastError: body?.error ?? `HTTP ${response.status}` });
      return { kind: "rejected", clientUuid, message: body?.error ?? `HTTP ${response.status}` };
    }

    return { kind: "queued", clientUuid, reason: `HTTP ${response.status}` };
  } catch (err) {
    return {
      kind: "queued",
      clientUuid,
      reason: err instanceof Error ? err.message : "network",
    };
  }
}

/**
 * Drain the queue. Station screens call this on load, on reconnect, and on a timer.
 *
 * Anything left SENDING by an interrupted page is put back first, otherwise it would
 * never be retried and the pending count would never reach zero.
 */
export async function drain() {
  await recoverInterrupted();
  const result = await flush(send);
  await pruneApplied().catch(() => undefined);
  return result;
}
