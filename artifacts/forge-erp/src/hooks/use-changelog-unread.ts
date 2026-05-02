import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import {
  countEntriesNewerThan,
  getLatestChangelogDate,
} from "@/lib/changelog-data";

const STORAGE_PREFIX = "forge-erp:changelog-last-seen:";
const CHANGE_EVENT = "forge-erp:changelog-last-seen-changed";

function storageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `${STORAGE_PREFIX}${userId}`;
}

function readLastSeen(userId: string | null | undefined): string | null {
  const key = storageKey(userId);
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLastSeen(
  userId: string | null | undefined,
  value: string,
): void {
  const key = storageKey(userId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, value);
    window.dispatchEvent(
      new CustomEvent(CHANGE_EVENT, { detail: { key, value } }),
    );
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

export function useChangelogUnread() {
  const { user, isLoaded } = useUser();
  const userId = user?.id ?? null;

  const [lastSeen, setLastSeen] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readLastSeen(userId),
  );

  useEffect(() => {
    if (!isLoaded) return;
    setLastSeen(readLastSeen(userId));
  }, [userId, isLoaded]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = storageKey(userId);
    if (!key) return;

    function onStorage(e: StorageEvent) {
      if (e.key === key) {
        setLastSeen(e.newValue);
      }
    }
    function onCustom(e: Event) {
      const detail = (e as CustomEvent<{ key: string; value: string }>).detail;
      if (detail?.key === key) {
        setLastSeen(detail.value);
      }
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onCustom as EventListener);
    };
  }, [userId]);

  const markChangelogSeen = useCallback(() => {
    const latest = getLatestChangelogDate();
    if (!latest) return;
    if (!userId) return;
    writeLastSeen(userId, latest);
  }, [userId]);

  const unreadCount =
    isLoaded && userId ? countEntriesNewerThan(lastSeen) : 0;

  return {
    lastSeen,
    unreadCount,
    markChangelogSeen,
  };
}
