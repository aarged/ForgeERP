/**
 * Verification script for the in-app docs search.
 *
 * Renders every guide via react-dom/server, parses the resulting HTML to
 * extract sections (mirroring what searchIndex.ts does in the browser), and
 * runs sample queries through searchDocs() to confirm the ranking is sane.
 *
 * Run with: pnpm --filter @workspace/forge-erp exec tsx scripts/verify-docs-search.mts
 */
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { searchDocs, type IndexedSection } from "../src/pages/docs/searchIndex";

const GUIDES = [
  { slug: "overview", label: "Product Overview", loader: () => import("../src/pages/docs/guides/overview") },
  { slug: "dashboard", label: "Dashboard", loader: () => import("../src/pages/docs/guides/dashboard") },
  { slug: "master-data", label: "Master Data", loader: () => import("../src/pages/docs/guides/master-data") },
  { slug: "procurement", label: "Procurement", loader: () => import("../src/pages/docs/guides/procurement") },
  { slug: "sales", label: "Sales", loader: () => import("../src/pages/docs/guides/sales") },
  { slug: "inventory", label: "Inventory", loader: () => import("../src/pages/docs/guides/inventory") },
  { slug: "finance", label: "Finance", loader: () => import("../src/pages/docs/guides/finance") },
  { slug: "reports", label: "Reports", loader: () => import("../src/pages/docs/guides/reports") },
  { slug: "picking", label: "Mobile Picking PWA", loader: () => import("../src/pages/docs/guides/picking") },
  { slug: "administration", label: "Administration", loader: () => import("../src/pages/docs/guides/administration") },
  { slug: "changelog", label: "Changelog", loader: () => import("../src/pages/docs/guides/changelog") },
];

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

async function buildIndexNode(): Promise<IndexedSection[]> {
  const sections: IndexedSection[] = [];
  for (const meta of GUIDES) {
    const mod = await meta.loader();
    const Comp = (mod as { default: ComponentType }).default;
    const html = renderToStaticMarkup(createElement(Comp));

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const guideTitle = titleMatch ? stripTags(titleMatch[1]) : meta.label;

    const sectionRe = /<section\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g;
    let m: RegExpExecArray | null;
    while ((m = sectionRe.exec(html)) !== null) {
      const sectionId = m[1];
      const inner = m[2];
      const h2 = inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      const sectionTitle = h2 ? stripTags(h2[1]) : "";
      const rest = inner.replace(/<h2[^>]*>[\s\S]*?<\/h2>/, "");
      const text = stripTags(rest);
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
    }
  }
  return sections;
}

type Expectation = {
  query: string;
  topGuide: string;
  sectionContains: string;
  /** Snippet must contain at least one of these terms (case-insensitive). */
  snippetAnyOf: string[];
};

const EXPECTATIONS: Expectation[] = [
  { query: "approval threshold", topGuide: "finance", sectionContains: "approval threshold", snippetAnyOf: ["approval", "threshold"] },
  { query: "ATP check", topGuide: "sales", sectionContains: "atp", snippetAnyOf: ["atp"] },
  { query: "stocktake", topGuide: "inventory", sectionContains: "stocktake", snippetAnyOf: ["stocktake"] },
  { query: "GR-IR", topGuide: "finance", sectionContains: "automatic gl postings", snippetAnyOf: ["gr-ir"] },
  { query: "trial balance", topGuide: "finance", sectionContains: "trial balance", snippetAnyOf: ["trial balance"] },
  { query: "lot serial", topGuide: "inventory", sectionContains: "lot and serial", snippetAnyOf: ["lot", "serial"] },
  { query: "audit log", topGuide: "administration", sectionContains: "audit", snippetAnyOf: ["audit"] },
];

async function main() {
  const index = await buildIndexNode();
  console.log(`Indexed ${index.length} sections across ${GUIDES.length} guides.\n`);

  const bySlug: Record<string, number> = {};
  for (const s of index) bySlug[s.guideSlug] = (bySlug[s.guideSlug] ?? 0) + 1;
  for (const slug of Object.keys(bySlug)) {
    console.log(`  ${slug.padEnd(16)} ${bySlug[slug]} sections`);
  }
  console.log("");

  // Verify every section has a non-empty id, title, and text.
  let structuralFailures = 0;
  for (const s of index) {
    if (!s.sectionId || !s.sectionTitle || !s.text) {
      console.error(`  ✗ Bad section: ${s.guideSlug} / "${s.sectionTitle}" (id="${s.sectionId}", text length=${s.text.length})`);
      structuralFailures++;
    }
  }
  if (structuralFailures === 0) {
    console.log(`  ✓ All ${index.length} sections have id, title, and body text`);
  }
  console.log("");

  // Verify section IDs are unique within a guide (anchor scrolling requires this).
  const idsByGuide: Record<string, Set<string>> = {};
  let dupFailures = 0;
  for (const s of index) {
    const set = (idsByGuide[s.guideSlug] ??= new Set());
    if (set.has(s.sectionId)) {
      console.error(`  ✗ Duplicate section id in ${s.guideSlug}: #${s.sectionId}`);
      dupFailures++;
    }
    set.add(s.sectionId);
  }
  if (dupFailures === 0) {
    console.log(`  ✓ Section IDs are unique within every guide`);
  }
  console.log("");

  // Run each search expectation.
  let queryFailures = 0;
  for (const exp of EXPECTATIONS) {
    const results = searchDocs(exp.query, index);
    const top = results[0];
    const snippetText = top?.snippet
      ? (top.snippet.before + top.snippet.match + top.snippet.after).toLowerCase()
      : "";
    const ok =
      results.length > 0 &&
      top.section.guideSlug === exp.topGuide &&
      top.section.sectionTitle.toLowerCase().includes(exp.sectionContains) &&
      !!top.snippet &&
      exp.snippetAnyOf.some((t) => snippetText.includes(t.toLowerCase()));
    const tag = ok ? "✓" : "✗";
    console.log(
      `  ${tag} query="${exp.query}" → top=${top ? `${top.section.guideSlug}/"${top.section.sectionTitle}" (score=${top.score})` : "(no results)"}`,
    );
    if (top?.snippet) {
      const snippet = `${top.snippet.before}[${top.snippet.match}]${top.snippet.after}`;
      console.log(`      snippet: ${snippet.slice(0, 160)}`);
    }
    if (!ok) queryFailures++;
  }
  console.log("");

  // Verify empty query returns no results, and a no-match query returns nothing.
  const empty = searchDocs("", index);
  const noMatch = searchDocs("zzzzz-no-such-thing-xyz123", index);
  const edgeOk = empty.length === 0 && noMatch.length === 0;
  console.log(
    `  ${edgeOk ? "✓" : "✗"} edge cases: empty query → ${empty.length} results, gibberish → ${noMatch.length} results`,
  );

  const totalFailures = structuralFailures + dupFailures + queryFailures + (edgeOk ? 0 : 1);
  if (totalFailures > 0) {
    console.error(`\n${totalFailures} failure(s).`);
    process.exit(1);
  } else {
    console.log(`\nAll docs-search checks passed.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
