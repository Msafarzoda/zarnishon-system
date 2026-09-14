/**
 * The station side of the offline story.
 *
 * A gate, weighbridge or cash desk must keep working when the internet drops — trucks
 * do not stop arriving. Every mutation is written to an IndexedDB outbox first, with a
 * client-generated UUID, and flushed to the server when the connection returns.
 *
 * The UUID is what makes a flaky connection safe: the server records the outcome against
 * it, so replaying an operation returns the original result instead of doing the work
 * twice. A truck weighed once is weighed once; a farmer paid once is paid once.
 */

const DB_NAME = "zarnishon-outbox";
const DB_VERSION = 1;
const STORE = "operations";

export type OutboxStatus = "PENDING" | "SENDING" | "APPLIED" | "REJECTED";

/** What a queued operation should do with the answer the server gave it. */
export type Disposition = "applied" | "requeue" | "rejected";

/**
 * Decide an operation's fate from the HTTP status alone.
 *
 * The distinction that matters: **"the server refused this operation" is not the same as
 * "the server refused this person".**
 *
 * A 401/403 means the wrong user is signed in on this shared browser, or a session
 * expired while the work sat in the queue. The weighing itself is perfectly good, so it
 * is requeued and goes through when its author signs in again. Treating it as a refusal
 * silently destroyed real weighings.
 *
 * Any other 4xx is the business rejecting it on its merits — already paid, tare above
 * gross — which will never succeed however often it is retried, so it is surfaced to the
 * operator instead of being retried for ever.
 */
export function dispositionFor(status: number): Disposition {
  if (status >= 200 && status < 300) return "applied";
  if (status === 401 || status === 403) return "requeue";
  if (status >= 400 && status < 500) return "rejected";
  return "requeue"; // 5xx — the server is unwell, not the operation
}

export interface OutboxOperation<T = unknown> {
  /** Idempotency key. Generated here, on the station, before anything is sent. */
  clientUuid: string;
  /**
   * Who was signed in when this was queued.
   *
   * One browser is used by a whole shift — the weigher signs out, the cashier signs in.
   * The outbox is shared across them, so without this the cashier's session would flush
   * the weigher's queued weighings, the server would refuse them as the wrong role, and
   * real work would be thrown away. Only the author's own session sends their work.
   */
  userId?: string;
  /** Server endpoint path, e.g. "/api/tickets/weigh". */
  operation: string;
  payload: T;
  status: OutboxStatus;
  /** When the operator actually did it — not when the server heard about it. */
  clientTimestamp: string;
  attempts: number;
  lastError?: string;
  result?: unknown;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "clientUuid" });
        store.createIndex("status", "status");
        store.createIndex("clientTimestamp", "clientTimestamp");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = fn(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

export function newClientUuid(): string {
  return crypto.randomUUID();
}

const ACTOR_KEY = "zarnishon-actor";

/** Remember who is signed in on this tab, so queued work is sent under the right session. */
export function setActor(userId: string): void {
  try {
    sessionStorage.setItem(ACTOR_KEY, userId);
  } catch {
    // Private window — the queue simply will not be filtered by author.
  }
}

export function currentActor(): string | undefined {
  try {
    return sessionStorage.getItem(ACTOR_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Work queued by whoever is signed in now. Operations from before this change have no
 *  author recorded and are treated as everyone's, so nothing is stranded. */
function ownedByCurrentActor(op: OutboxOperation): boolean {
  const actor = currentActor();
  return !actor || !op.userId || op.userId === actor;
}

/** Queue an operation. Returns immediately — the screen must not wait on the network. */
export async function enqueue<T>(
  operation: string,
  payload: T,
  clientUuid = newClientUuid(),
): Promise<OutboxOperation<T>> {
  const op: OutboxOperation<T> = {
    clientUuid,
    userId: currentActor(),
    operation,
    payload,
    status: "PENDING",
    clientTimestamp: new Date().toISOString(),
    attempts: 0,
  };
  await tx("readwrite", (store) => store.put(op));
  return op;
}

/** Read one operation back by its idempotency key. */
export async function get(clientUuid: string): Promise<OutboxOperation | undefined> {
  return await tx<OutboxOperation | undefined>("readonly", (store) => store.get(clientUuid));
}

/**
 * Move an operation to a new status without disturbing its payload or its UUID.
 * Used when a screen sends an operation itself and learns the outcome immediately.
 */
export async function setStatus(
  clientUuid: string,
  status: OutboxStatus,
  extra: { result?: unknown; lastError?: string } = {},
): Promise<void> {
  const op = await get(clientUuid);
  if (!op) return;
  op.status = status;
  if ("result" in extra) op.result = extra.result;
  if ("lastError" in extra) op.lastError = extra.lastError;
  if (status === "APPLIED") op.lastError = undefined;
  await tx("readwrite", (store) => store.put(op));
}

/**
 * Put interrupted operations back in the queue.
 *
 * An operation is marked SENDING while its request is in flight. If the page is
 * navigated, reloaded, or frozen by a print dialog at that moment, nothing ever moves it
 * on — it sits in SENDING for ever and the station shows "waiting to send" with a number
 * that never goes down and no way to see what it is.
 *
 * Re-sending is safe: every operation carries its client UUID and the server returns the
 * original outcome rather than doing the work twice. Call this when a station screen
 * loads.
 */
export async function recoverInterrupted(): Promise<number> {
  const all = await tx<OutboxOperation[]>("readonly", (store) => store.getAll());
  const stuck = all.filter((op) => op.status === "SENDING" && ownedByCurrentActor(op));
  for (const op of stuck) {
    op.status = "PENDING";
    op.lastError = "interrupted";
    await tx("readwrite", (store) => store.put(op));
  }
  return stuck.length;
}

export async function pending(): Promise<OutboxOperation[]> {
  const all = await tx<OutboxOperation[]>("readonly", (store) => store.getAll());
  return all
    .filter((op) => op.status === "PENDING" || op.status === "SENDING")
    .filter(ownedByCurrentActor)
    .sort((a, b) => a.clientTimestamp.localeCompare(b.clientTimestamp));
}

export async function pendingCount(): Promise<number> {
  return (await pending()).length;
}

async function update(op: OutboxOperation): Promise<void> {
  await tx("readwrite", (store) => store.put(op));
}

export interface FlushResult {
  applied: number;
  rejected: number;
  stillPending: number;
}

/**
 * Send everything queued, oldest first and strictly in order — a tare must not reach the
 * server before its gross. The first operation that cannot be sent stops the flush and
 * leaves the rest queued; the next flush picks up where this one stopped.
 *
 * A 4xx is the server refusing the operation on its merits (already paid, bad weight).
 * That is final, so it is marked REJECTED and surfaced to the operator rather than
 * retried for ever. Anything else is treated as a connection problem and retried.
 */
export async function flush(
  send: (op: OutboxOperation) => Promise<Response>,
): Promise<FlushResult> {
  const queue = await pending();
  let applied = 0;
  let rejected = 0;

  for (const op of queue) {
    op.status = "SENDING";
    op.attempts += 1;
    await update(op);

    let response: Response;
    try {
      response = await send(op);
    } catch (err) {
      // Offline or unreachable — stop, keep order, try again later.
      op.status = "PENDING";
      op.lastError = err instanceof Error ? err.message : String(err);
      await update(op);
      break;
    }

    const disposition = dispositionFor(response.status);

    if (disposition === "applied") {
      op.status = "APPLIED";
      op.result = await response.json().catch(() => null);
      op.lastError = undefined;
      await update(op);
      applied += 1;
      continue;
    }

    if (disposition === "rejected") {
      op.status = "REJECTED";
      op.lastError = await response.text().catch(() => `HTTP ${response.status}`);
      await update(op);
      rejected += 1;
      continue;
    }

    // Requeue and stop, keeping order. The next flush picks up where this one stopped.
    op.status = "PENDING";
    op.lastError =
      response.status === 401 || response.status === 403
        ? "not signed in as the operator who recorded this"
        : `HTTP ${response.status}`;
    await update(op);
    break;
  }

  return { applied, rejected, stillPending: (await pending()).length };
}

/** Operations the server refused. These need a human — they are never retried silently. */
export async function rejected(): Promise<OutboxOperation[]> {
  const all = await tx<OutboxOperation[]>("readonly", (store) => store.getAll());
  return all.filter((op) => op.status === "REJECTED" && ownedByCurrentActor(op));
}

/** Clear operations the server has confirmed, keeping a short local history. */
export async function pruneApplied(keepLast = 200): Promise<number> {
  const all = await tx<OutboxOperation[]>("readonly", (store) => store.getAll());
  const doomed = all
    .filter((op) => op.status === "APPLIED")
    .sort((a, b) => a.clientTimestamp.localeCompare(b.clientTimestamp))
    .slice(0, Math.max(0, all.filter((o) => o.status === "APPLIED").length - keepLast));
  for (const op of doomed) {
    await tx("readwrite", (store) => store.delete(op.clientUuid));
  }
  return doomed.length;
}

/** Discard one operation the server refused. Only a REJECTED one — nothing unsent. */
export async function discard(clientUuid: string): Promise<boolean> {
  const op = await get(clientUuid);
  if (!op || op.status !== "REJECTED") return false;
  await tx("readwrite", (store) => store.delete(clientUuid));
  return true;
}
