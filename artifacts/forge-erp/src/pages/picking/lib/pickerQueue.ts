/**
 * IndexedDB-backed offline queue for picker mutations.
 *
 * The picker UI in the warehouse may lose connectivity at any moment.
 * Every mutation (assign, start, confirm-line, short-pick, complete) is
 * enqueued here first; we then attempt to replay them in order whenever the
 * browser reports `online` or when a manual flush is requested.
 *
 * NOTE: GET requests are NOT queued — they read from the API or the service
 * worker's last-known cached response.
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "forge-picker";
const DB_VERSION = 1;
const STORE = "outbox";

export interface QueuedRequest {
  id?: number;
  url: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body: unknown;
  headers: Record<string, string>;
  /** Free-form label for the UI (e.g. "Confirm PS-000123 line 2"). */
  label: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB not available"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        }
      },
    });
  }
  return dbPromise;
}

export async function enqueue(req: Omit<QueuedRequest, "id" | "createdAt" | "attempts">): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  const id = (await tx.store.add({ ...req, createdAt: Date.now(), attempts: 0 })) as number;
  await tx.done;
  return id;
}

export async function listQueue(): Promise<QueuedRequest[]> {
  const db = await getDb();
  return db.getAll(STORE) as Promise<QueuedRequest[]>;
}

export async function removeQueued(id: number): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

export async function clearQueue(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE);
}

export type FlushResult = {
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
};

/**
 * Attempt to replay every queued request in order. Each successful replay is
 * removed from the store; failed ones stay in place with `attempts` incremented
 * and the latest error message recorded for the UI.
 */
export async function flushQueue(
  fetchImpl: typeof fetch = fetch,
): Promise<FlushResult> {
  const items = await listQueue();
  const result: FlushResult = { total: items.length, succeeded: 0, failed: 0, errors: [] };
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt);
  for (const item of sorted) {
    try {
      const res = await fetchImpl(item.url, {
        method: item.method,
        headers: { "Content-Type": "application/json", ...item.headers },
        body: JSON.stringify(item.body),
        credentials: "include",
      });
      if (!res.ok) {
        // 4xx (other than 401) means our payload is invalid — drop it so it
        // doesn't permanently block the queue. 5xx → keep & retry later.
        if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429) {
          if (item.id != null) await removeQueued(item.id);
          const detail = await res.text().catch(() => "");
          result.errors.push(`${item.label}: ${res.status} ${detail.slice(0, 200)}`);
          result.failed += 1;
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
        continue;
      }
      if (item.id != null) await removeQueued(item.id);
      result.succeeded += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const db = await getDb();
      const tx = db.transaction(STORE, "readwrite");
      const existing = (await tx.store.get(item.id!)) as QueuedRequest | undefined;
      if (existing) {
        existing.attempts += 1;
        existing.lastError = msg;
        await tx.store.put(existing);
      }
      await tx.done;
      result.failed += 1;
      result.errors.push(`${item.label}: ${msg}`);
      // Stop replaying so we keep ordering — try again next flush.
      break;
    }
  }
  return result;
}
