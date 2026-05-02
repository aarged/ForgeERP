import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { DocPage, DocSection, P, Callout } from "../components";
import { CHANGELOG } from "@/lib/changelog-data";
import { useChangelogUnread } from "@/hooks/use-changelog-unread";

const moduleColors: Record<string, string> = {
  Dashboard: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
  "Master Data":
    "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200",
  Procurement:
    "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  Sales:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  Inventory:
    "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
  Finance:
    "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
  Reports:
    "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
  Mobile:
    "bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200",
  Administration:
    "bg-zinc-200 text-zinc-900 dark:bg-zinc-700/60 dark:text-zinc-100",
  Docs: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-900/40 dark:text-fuchsia-200",
};

function ModuleTag({ name }: { name: string }) {
  const cls = moduleColors[name] ?? "bg-muted text-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${cls}`}
      data-testid={`module-tag-${name}`}
    >
      {name}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function ChangelogGuide() {
  const { lastSeen, markChangelogSeen } = useChangelogUnread();
  // Snapshot lastSeen at mount so the "New" highlights persist for this
  // visit even after we mark the changelog as seen.
  const snapshotRef = useRef<string | null | undefined>(undefined);
  if (snapshotRef.current === undefined) {
    snapshotRef.current = lastSeen;
  }
  const snapshotLastSeen = snapshotRef.current;

  // After capturing the snapshot, mark the changelog as seen so the sidebar
  // badge clears and future visits compare against today's latest entry.
  useEffect(() => {
    markChangelogSeen();
  }, [markChangelogSeen]);

  return (
    <DocPage
      title="Changelog"
      intro="Every shipped change to Forge ERP, newest first. Each entry has the date it shipped, the module(s) it touched, and a one-line description. Use this page to see what's new since you last logged in."
    >
      <Callout kind="info" title="How this list is maintained">
        Every feature task ends with a documentation step. When a contributor
        ships a change they edit the matching module guide and add a dated
        entry here so the changelog and the docs always agree with the running
        app.
      </Callout>

      {CHANGELOG.map((month) => (
        <DocSection key={month.label} title={month.label}>
          <ul className="space-y-4">
            {month.entries.map((entry, idx) => {
              const isNew =
                snapshotLastSeen === null || entry.date > snapshotLastSeen;
              return (
                <li
                  key={`${entry.date}-${idx}`}
                  className="rounded-md border bg-card p-4"
                  data-testid={`changelog-entry-${entry.date}-${idx}`}
                  data-new={isNew ? "true" : undefined}
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {formatDate(entry.date)}
                    </Badge>
                    {entry.modules.map((m) => (
                      <ModuleTag key={m} name={m} />
                    ))}
                    {isNew && (
                      <Badge
                        className="bg-primary text-primary-foreground text-[10px] uppercase tracking-wider px-1.5 py-0"
                        data-testid={`changelog-new-badge-${entry.date}-${idx}`}
                      >
                        New
                      </Badge>
                    )}
                  </div>
                  <P>{entry.description}</P>
                </li>
              );
            })}
          </ul>
        </DocSection>
      ))}
    </DocPage>
  );
}
