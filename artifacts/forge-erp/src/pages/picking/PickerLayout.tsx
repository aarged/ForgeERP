import type { ReactNode } from "react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { useOfflineQueue } from "./lib/useOfflineQueue";

export interface PickerLayoutProps {
  title: string;
  back?: { label: string; to: string };
  right?: ReactNode;
  children: ReactNode;
}

/**
 * Full-screen layout used by all picker routes. Designed for tablet/phone
 * portrait orientation: large hit-targets, sticky offline banner, single
 * column. The layout deliberately does NOT render the main app shell — the
 * picker is a focused PWA experience.
 */
export function PickerLayout({ title, back, right, children }: PickerLayoutProps) {
  const { online, items, pendingPhotos, flushing, flush } = useOfflineQueue();
  const { user } = useUser();
  const queued = items.length;

  return (
    <div className="min-h-[100dvh] bg-slate-50 text-slate-900 flex flex-col" data-testid="picker-shell">
      <header className="sticky top-0 z-30 bg-slate-900 text-white shadow">
        <div className="flex items-center gap-2 px-3 py-2">
          {back ? (
            <Link
              to={back.to}
              className="rounded bg-white/15 px-2 py-1 text-sm"
              data-testid="link-picker-back"
            >
              ← {back.label}
            </Link>
          ) : (
            <Link to="/picking" className="font-semibold" data-testid="link-picker-home">
              Forge Picker
            </Link>
          )}
          <h1 className="ml-2 truncate text-base font-semibold flex-1" data-testid="text-picker-title">
            {title}
          </h1>
          {right}
        </div>
        <div
          className={`flex items-center justify-between gap-2 px-3 py-1 text-xs ${online ? "bg-emerald-700" : "bg-amber-700"}`}
          data-testid="picker-status-bar"
        >
          <span className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-300" : "bg-amber-300"}`}
              aria-hidden
            />
            {online ? "Online" : "Offline — actions will sync when back online"}
            {user?.primaryEmailAddress?.emailAddress ? (
              <span className="ml-2 hidden sm:inline opacity-80">· {user.primaryEmailAddress.emailAddress}</span>
            ) : null}
          </span>
          <span className="flex items-center gap-2">
            <span data-testid="text-queue-count">Queue: {queued}</span>
            {pendingPhotos > 0 ? (
              <span
                className="rounded bg-white/20 px-2 py-0.5"
                title="Photos waiting to upload"
                data-testid="text-pending-photos"
              >
                📷 {pendingPhotos} pending sync
              </span>
            ) : null}
            <button
              type="button"
              className="rounded bg-white/20 px-2 py-0.5 disabled:opacity-50"
              disabled={!online || queued === 0 || flushing}
              onClick={() => void flush()}
              data-testid="button-flush-queue"
            >
              {flushing ? "Syncing…" : "Sync now"}
            </button>
          </span>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
