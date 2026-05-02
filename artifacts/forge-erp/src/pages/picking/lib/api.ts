/**
 * Picker-specific API helper.
 *
 * Authentication: relies on the Clerk session cookie (credentials: "include").
 * The api-server resolves the tenant from the Clerk JWT publicMetadata claim,
 * so we don't need to inject `x-tenant-id` ourselves.
 *
 * For mutations: try the network first; on any failure (or `navigator.onLine
 * === false`) enqueue the request in IndexedDB so the picker can keep working
 * offline. The queue is replayed when connectivity returns.
 */
import { enqueue } from "./pickerQueue";

const HEADERS_JSON: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };

export async function pickerGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { Accept: "application/json" }, credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export type MutationResult<T> =
  | { ok: true; data: T; offline: false }
  | { ok: true; offline: true; queuedId: number };

export async function pickerMutate<T>(opts: {
  path: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  label: string;
}): Promise<MutationResult<T>> {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("offline");
    }
    const res = await fetch(`/api${opts.path}`, {
      method: opts.method,
      headers: HEADERS_JSON,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "include",
    });
    if (!res.ok) throw new Error(`${opts.method} ${opts.path} failed: ${res.status}`);
    if (res.status === 204) return { ok: true, data: undefined as unknown as T, offline: false };
    return { ok: true, data: (await res.json()) as T, offline: false };
  } catch {
    const queuedId = await enqueue({
      url: `/api${opts.path}`,
      method: opts.method,
      body: opts.body ?? {},
      headers: HEADERS_JSON,
      label: opts.label,
    });
    return { ok: true, offline: true, queuedId };
  }
}

export async function pickerUploadPhoto(blob: Blob, name = "pick.jpg"): Promise<string | null> {
  // Best-effort photo upload — when offline we skip the photo entirely so the
  // picker can still confirm the line. (A future enhancement could store the
  // blob in IndexedDB and upload during the next flush.)
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    const ticketRes = await fetch(`/api/storage/uploads/request-url`, {
      method: "POST",
      headers: HEADERS_JSON,
      credentials: "include",
      body: JSON.stringify({ name, size: blob.size, contentType: blob.type || "image/jpeg" }),
    });
    if (!ticketRes.ok) return null;
    const { uploadURL, objectPath } = (await ticketRes.json()) as { uploadURL: string; objectPath: string };
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
    });
    if (!putRes.ok) return null;
    return objectPath;
  } catch {
    return null;
  }
}
