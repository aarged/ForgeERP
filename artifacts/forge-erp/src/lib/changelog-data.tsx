import type { ReactNode } from "react";

export type ChangelogEntry = {
  date: string;
  modules: string[];
  description: ReactNode;
};

export type ChangelogMonth = {
  label: string;
  entries: ChangelogEntry[];
};

export const CHANGELOG: ChangelogMonth[] = [
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

export function getLatestChangelogDate(): string | null {
  let latest: string | null = null;
  for (const month of CHANGELOG) {
    for (const entry of month.entries) {
      if (latest === null || entry.date > latest) {
        latest = entry.date;
      }
    }
  }
  return latest;
}

export function countEntriesNewerThan(lastSeen: string | null): number {
  let count = 0;
  for (const month of CHANGELOG) {
    for (const entry of month.entries) {
      if (lastSeen === null || entry.date > lastSeen) {
        count += 1;
      }
    }
  }
  return count;
}
