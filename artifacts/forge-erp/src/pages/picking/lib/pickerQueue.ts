/**
 * IndexedDB-backed offline queue for picker mutations.
 *
 * The picker UI in the warehouse may lose connectivity at any moment.
 * Every mutation (assign, start, confirm-line, short-pick, complete) is
 * enqueued here first; we then attempt to replay them in order whenever the
 * browser reports `online` or when a manual flush is requested.
 *
 * Each queued mutation may also carry a binary `photo` payload — a blob the
 * picker captured for proof-of-pick. During flush we first request a signed
 * upload URL, PUT the blob to object storage, persist the resulting
 * `objectPath` back into the queue (so retries don't re-upload), then inject
 * the path into the request body under `photo.bodyField` before replaying.
 *
 * NOTE: GET requests are NOT queued — they read from the API or the service
 * worker's last-known cached response.
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "forge-picker";
const DB_VERSION = 2;
const STORE = "outbox";

export interface QueuedPhoto {
  /** The image bytes to upload. */
  blob: Blob;
  /** Filename hint for the upload request. */
  name: string;
  /** MIME type sent with the PUT. */
  contentType: string;
  /** Body field on the queued request that should receive the resulting object path (e.g. `photoObjectPath`). */
  bodyField: string;
  /** Populated after a successful upload so subsequent flush attempts don't re-upload. */
  objectPath?: string;
}

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
  /** Optional binary payload uploaded to object storage before the request is replayed. */
  photo?: QueuedPhoto;
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
        // v2: no schema change required — `photo` is just an optional field
        // on existing records. Old records without it continue to flush as
        // plain JSON mutations.
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

/** Persist a partial update to a queued record (e.g. attach the uploaded objectPath). */
async function patchQueued(id: number, patch: Partial<QueuedRequest>): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  const existing = (await tx.store.get(id)) as QueuedRequest | undefined;
  if (existing) {
    await tx.store.put({ ...existing, ...patch });
  }
  await tx.done;
}

export type FlushResult = {
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
};

/**
 * Upload a queued photo blob to object storage. Returns the resulting object
 * path, or throws if the request URL or PUT fails.
 */
async function uploadQueuedPhoto(photo: QueuedPhoto, fetchImpl: typeof fetch): Promise<string> {
  const ticketRes = await fetchImpl(`/api/storage/uploads/request-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({
      name: photo.name,
      size: photo.blob.size,
      contentType: photo.contentType || "image/jpeg",
    }),
  });
  if (!ticketRes.ok) throw new Error(`upload-url HTTP ${ticketRes.status}`);
  const { uploadURL, objectPath } = (await ticketRes.json()) as { uploadURL: string; objectPath: string };
  const putRes = await fetchImpl(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": photo.contentType || "image/jpeg" },
    body: photo.blob,
  });
  if (!putRes.ok) throw new Error(`upload PUT HTTP ${putRes.status}`);
  return objectPath;
}

/**
 * Attempt to replay every queued request in order. Each successful replay is
 * removed from the store; failed ones stay in place with `attempts` incremented
 * and the latest error message recorded for the UI.
 *
 * For requests that carry a `photo`, the blob is uploaded first; the resulting
 * objectPath is persisted back to IDB before the request is replayed so that
 * a network blip between PUT and POST doesn't waste bandwidth on a re-upload.
 */
export async function flushQueue(
  fetchImpl: typeof fetch = fetch,
): Promise<FlushResult> {
  const items = await listQueue();
  const result: FlushResult = { total: items.length, succeeded: 0, failed: 0, errors: [] };
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt);
  for (const item of sorted) {
    try {
      // 1. If the item carries a photo and we haven't uploaded it yet, do that first.
      let body: unknown = item.body;
      if (item.photo) {
        let objectPath = item.photo.objectPath;
        if (!objectPath) {
          objectPath = await uploadQueuedPhoto(item.photo, fetchImpl);
          if (item.id != null) {
            await patchQueued(item.id, { photo: { ...item.photo, objectPath } });
          }
        }
        // Inject the object path into the body so the server can persist it.
        if (body && typeof body === "object") {
          body = { ...(body as Record<string, unknown>), [item.photo.bodyField]: objectPath };
        }
      }

      // 2. Replay the mutation.
      const res = await fetchImpl(item.url, {
        method: item.method,
        headers: { "Content-Type": "application/json", ...item.headers },
        body: JSON.stringify(body),
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
      if (item.id != null) {
        await patchQueued(item.id, { attempts: item.attempts + 1, lastError: msg });
      }
      result.failed += 1;
      result.errors.push(`${item.label}: ${msg}`);
      // Stop replaying so we keep ordering — try again next flush.
      break;
    }
  }
  return result;
}
