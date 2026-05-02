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
 *
 * Mutations may also carry an optional `photo` blob (see PhotoCapture). When
 * we're online and the upload succeeds we inline the resulting `objectPath`
 * into the body before sending. When we're offline (or the upload fails) the
 * blob is stashed alongside the queued request and uploaded by the background
 * flush — guaranteeing proof-of-pick photos are never silently dropped.
 */
import { enqueue, type QueuedPhoto } from "./pickerQueue";

const HEADERS_JSON: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };

export async function pickerGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { Accept: "application/json" }, credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Description of a photo to upload alongside a mutation. */
export interface MutationPhoto {
  blob: Blob;
  /** Filename hint sent with the upload-URL request. */
  name: string;
  /** Body field that should receive the resulting object path. Defaults to `photoObjectPath`. */
  bodyField?: string;
}

export type MutationResult<T> =
  | { ok: true; data: T; offline: false; photoQueued: false }
  | { ok: true; offline: true; queuedId: number; photoQueued: boolean };

/**
 * Try to upload a photo right now. Returns the object path on success or
 * `null` on any failure (so the caller can fall back to queuing).
 */
async function tryUploadPhoto(photo: MutationPhoto): Promise<string | null> {
  try {
    const ticketRes = await fetch(`/api/storage/uploads/request-url`, {
      method: "POST",
      headers: HEADERS_JSON,
      credentials: "include",
      body: JSON.stringify({
        name: photo.name,
        size: photo.blob.size,
        contentType: photo.blob.type || "image/jpeg",
      }),
    });
    if (!ticketRes.ok) return null;
    const { uploadURL, objectPath } = (await ticketRes.json()) as { uploadURL: string; objectPath: string };
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": photo.blob.type || "image/jpeg" },
      body: photo.blob,
    });
    if (!putRes.ok) return null;
    return objectPath;
  } catch {
    return null;
  }
}

export async function pickerMutate<T>(opts: {
  path: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  label: string;
  photo?: MutationPhoto;
}): Promise<MutationResult<T>> {
  const bodyField = opts.photo?.bodyField ?? "photoObjectPath";
  const baseBody = (opts.body && typeof opts.body === "object" ? { ...(opts.body as Record<string, unknown>) } : opts.body) as
    | Record<string, unknown>
    | undefined;
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("offline");
    }
    // 1. If a photo is attached, upload it first. On failure, fall through to
    //    the offline queue so the blob is preserved.
    let bodyToSend: unknown = baseBody;
    if (opts.photo) {
      const objectPath = await tryUploadPhoto(opts.photo);
      if (!objectPath) throw new Error("photo-upload-failed");
      bodyToSend = { ...(baseBody ?? {}), [bodyField]: objectPath };
    }

    const res = await fetch(`/api${opts.path}`, {
      method: opts.method,
      headers: HEADERS_JSON,
      body: bodyToSend !== undefined ? JSON.stringify(bodyToSend) : undefined,
      credentials: "include",
    });
    if (!res.ok) throw new Error(`${opts.method} ${opts.path} failed: ${res.status}`);
    if (res.status === 204) {
      return { ok: true, data: undefined as unknown as T, offline: false, photoQueued: false };
    }
    return { ok: true, data: (await res.json()) as T, offline: false, photoQueued: false };
  } catch {
    const queuedPhoto: QueuedPhoto | undefined = opts.photo
      ? {
          blob: opts.photo.blob,
          name: opts.photo.name,
          contentType: opts.photo.blob.type || "image/jpeg",
          bodyField,
        }
      : undefined;
    const queuedId = await enqueue({
      url: `/api${opts.path}`,
      method: opts.method,
      body: baseBody ?? {},
      headers: HEADERS_JSON,
      label: opts.label,
      photo: queuedPhoto,
    });
    return { ok: true, offline: true, queuedId, photoQueued: Boolean(queuedPhoto) };
  }
}

/**
 * Standalone photo upload — kept for callers that just want a one-shot upload
 * (e.g. ad-hoc attachments). Returns `null` if offline or anything fails. For
 * proof-of-pick photos that must survive offline, prefer `pickerMutate`'s
 * `photo` option, which queues the blob alongside its line confirmation.
 */
export async function pickerUploadPhoto(blob: Blob, name = "pick.jpg"): Promise<string | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  return tryUploadPhoto({ blob, name });
}
