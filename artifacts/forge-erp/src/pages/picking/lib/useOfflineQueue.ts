/**
 * React hook that exposes the offline-mutation queue: live count + a flush
 * trigger. Re-flushes automatically whenever the browser fires `online` or
 * the page becomes visible again.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { flushQueue, listQueue, type QueuedRequest } from "./pickerQueue";

export interface OfflineQueueState {
  online: boolean;
  items: QueuedRequest[];
  /** Number of queued mutations that still carry an un-uploaded photo. */
  pendingPhotos: number;
  flushing: boolean;
  lastFlushAt: number | null;
  lastFlushError: string | null;
  refresh: () => Promise<void>;
  flush: () => Promise<void>;
}

/**
 * Extracts the `lineId` segment from a queued URL such as
 * `/api/sales/pick-slips/12/lines/34/confirm` so the slip page can decorate
 * the matching line with a "photo pending sync" badge. Returns `null` if the
 * URL doesn't follow the expected shape.
 */
export function pendingPhotoLineIdFor(req: QueuedRequest): number | null {
  if (!req.photo || req.photo.objectPath) return null;
  const m = /\/lines\/(\d+)\//.exec(req.url);
  return m ? Number(m[1]) : null;
}

export function useOfflineQueue(): OfflineQueueState {
  const [items, setItems] = useState<QueuedRequest[]>([]);
  const [online, setOnline] = useState<boolean>(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [flushing, setFlushing] = useState(false);
  const [lastFlushAt, setLastFlushAt] = useState<number | null>(null);
  const [lastFlushError, setLastFlushError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listQueue();
      setItems(list);
    } catch {
      setItems([]);
    }
  }, []);

  const flush = useCallback(async () => {
    if (flushing) return;
    setFlushing(true);
    try {
      const result = await flushQueue();
      setLastFlushAt(Date.now());
      setLastFlushError(result.errors[0] ?? null);
    } finally {
      setFlushing(false);
      await refresh();
    }
  }, [flushing, refresh]);

  useEffect(() => {
    void refresh();
    const onOnline = () => {
      setOnline(true);
      void flush();
    };
    const onOffline = () => setOnline(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        if (navigator.onLine) void flush();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => {
      void refresh();
    }, 5_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [refresh, flush]);

  const pendingPhotos = useMemo(
    () => items.filter((it) => it.photo && !it.photo.objectPath).length,
    [items],
  );

  return { online, items, pendingPhotos, flushing, lastFlushAt, lastFlushError, refresh, flush };
}
