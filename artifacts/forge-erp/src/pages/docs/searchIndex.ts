import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type GuideMeta = {
  slug: string;
  label: string;
  loader: () => Promise<{ default: ComponentType }>;
};

const GUIDE_META: GuideMeta[] = [
  {
    slug: "overview",
    label: "Product Overview",
    loader: () => import("./guides/overview"),
  },
  {
    slug: "dashboard",
    label: "Dashboard",
    loader: () => import("./guides/dashboard"),
  },
  {
    slug: "master-data",
    label: "Master Data",
    loader: () => import("./guides/master-data"),
  },
  {
    slug: "procurement",
    label: "Procurement",
    loader: () => import("./guides/procurement"),
  },
  {
    slug: "sales",
    label: "Sales",
    loader: () => import("./guides/sales"),
  },
  {
    slug: "inventory",
    label: "Inventory",
    loader: () => import("./guides/inventory"),
  },
  {
    slug: "finance",
    label: "Finance",
    loader: () => import("./guides/finance"),
  },
  {
    slug: "reports",
    label: "Reports",
    loader: () => import("./guides/reports"),
  },
  {
    slug: "picking",
    label: "Mobile Picking PWA",
    loader: () => import("./guides/picking"),
  },
  {
    slug: "administration",
    label: "Administration",
    loader: () => import("./guides/administration"),
  },
  {
    slug: "changelog",
    label: "Changelog",
    loader: () => import("./guides/changelog"),
  },
];

export type IndexedSection = {
  guideSlug: string;
  guideLabel: string;
  guideTitle: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
  textLower: string;
  titleLower: string;
};

export type SearchResult = {
  section: IndexedSection;
  score: number;
  snippet: { before: string; match: string; after: string } | null;
};

let indexPromise: Promise<IndexedSection[]> | null = null;

export function getDocsIndex(): Promise<IndexedSection[]> {
  if (!indexPromise) {
    indexPromise = buildIndex().catch((err) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

async function buildIndex(): Promise<IndexedSection[]> {
  const modules = await Promise.all(GUIDE_META.map((g) => g.loader()));
  const sections: IndexedSection[] = [];

  for (let i = 0; i < GUIDE_META.length; i++) {
    const meta = GUIDE_META[i];
    const Comp = modules[i].default;
    let html: string;
    try {
      html = renderToStaticMarkup(createElement(Comp));
    } catch {
      continue;
    }

    const doc = new DOMParser().parseFromString(
      `<div id="root">${html}</div>`,
      "text/html",
    );
    const root = doc.getElementById("root");
    if (!root) continue;

    const guideTitle =
      root.querySelector("h1")?.textContent?.trim() || meta.label;

    const sectionEls = root.querySelectorAll("section[id]");
    sectionEls.forEach((sec) => {
      const sectionId = sec.id;
      if (!sectionId) return;
      const titleEl = sec.querySelector("h2");
      const sectionTitle = titleEl?.textContent?.trim() || "";
      const rawText = (sec.textContent || "").replace(/\s+/g, " ").trim();
      const text =
        sectionTitle && rawText.startsWith(sectionTitle)
          ? rawText.slice(sectionTitle.length).trim()
          : rawText;

      sections.push({
        guideSlug: meta.slug,
        guideLabel: meta.label,
        guideTitle,
        sectionId,
        sectionTitle,
        text,
        textLower: text.toLowerCase(),
        titleLower: sectionTitle.toLowerCase(),
      });
    });
  }

  return sections;
}

function makeSnippet(
  text: string,
  terms: string[],
  fullQuery: string,
): { before: string; match: string; after: string } | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let idx = -1;
  let matchLen = 0;

  if (fullQuery.length >= 2) {
    const i = lower.indexOf(fullQuery);
    if (i !== -1) {
      idx = i;
      matchLen = fullQuery.length;
    }
  }

  if (idx === -1) {
    for (const term of terms) {
      const i = lower.indexOf(term);
      if (i !== -1 && (idx === -1 || i < idx)) {
        idx = i;
        matchLen = term.length;
      }
    }
  }

  if (idx === -1) return null;

  const radius = 70;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + matchLen + radius);

  const before = (start > 0 ? "… " : "") + text.slice(start, idx);
  const match = text.slice(idx, idx + matchLen);
  const after =
    text.slice(idx + matchLen, end) + (end < text.length ? " …" : "");

  return { before, match, after };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

export function searchDocs(
  query: string,
  index: IndexedSection[],
  limit = 8,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = Array.from(new Set(q.split(/\s+/).filter((t) => t.length > 0)));
  if (terms.length === 0) return [];

  const isPhrase = q.length >= 2 && terms.length > 1;
  const results: SearchResult[] = [];

  for (const section of index) {
    let score = 0;

    if (q.length >= 2 && section.titleLower.includes(q)) {
      score += 100;
    }
    if (isPhrase && section.textLower.includes(q)) {
      score += 35;
    }

    let allTermsHit = true;
    for (const term of terms) {
      let hit = false;
      if (section.titleLower.includes(term)) {
        score += 25;
        hit = true;
      }
      const bodyHits = countOccurrences(section.textLower, term);
      if (bodyHits > 0) {
        score += Math.min(bodyHits, 8);
        hit = true;
      }
      if (section.guideTitle.toLowerCase().includes(term)) {
        score += 6;
        hit = true;
      } else if (section.guideLabel.toLowerCase().includes(term)) {
        score += 6;
        hit = true;
      }
      if (!hit) allTermsHit = false;
    }

    if (terms.length > 1 && allTermsHit) {
      score += 15;
    }

    if (score > 0) {
      results.push({
        section,
        score,
        snippet: makeSnippet(section.text, terms, q),
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.section.sectionTitle.localeCompare(b.section.sectionTitle);
  });

  return results.slice(0, limit);
}
