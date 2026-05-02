import { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { DocPage, DocSection, P, Callout } from "../components";

type ChangelogEntry = {
  date: string;
  modules: string[];
  description: ReactNode;
};

type ChangelogMonth = {
  label: string;
  entries: ChangelogEntry[];
};

const CHANGELOG: ChangelogMonth[] = [
  {
    label: "May 2026",
    entries: [
      {
        date: "2026-05-02",
        modules: ["Docs"],
        description:
          "Initial documentation release. Added the in-app Help & Docs section with a product overview, per-module user guides for every module, the Mobile Picking PWA and Administration, and this Changelog.",
      },
      {
        date: "2026-05-02",
        modules: [
          "Dashboard",
          "Master Data",
          "Procurement",
          "Sales",
          "Inventory",
          "Finance",
          "Reports",
          "Mobile",
          "Administration",
        ],
        description: (
          <>
            Documentation backfill: captured the current shipped state of every
            module — role-based dashboard, master data with bulk
            import/export, requisition-to-receipt procurement workflow,
            quotation-to-invoice sales workflow with ATP, multi-warehouse
            inventory with lot/serial tracking, finance with automatic GL
            postings, the full reports catalogue, the offline-friendly
            picking PWA, and the role-based administration tools (members,
            audit log, onboarding wizard).
          </>
        ),
      },
    ],
  },
];

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
            {month.entries.map((entry, idx) => (
              <li
                key={`${entry.date}-${idx}`}
                className="rounded-md border bg-card p-4"
                data-testid={`changelog-entry-${entry.date}-${idx}`}
              >
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {formatDate(entry.date)}
                  </Badge>
                  {entry.modules.map((m) => (
                    <ModuleTag key={m} name={m} />
                  ))}
                </div>
                <P>{entry.description}</P>
              </li>
            ))}
          </ul>
        </DocSection>
      ))}
    </DocPage>
  );
}
