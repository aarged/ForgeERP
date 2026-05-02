# Maintaining the Forge ERP Docs

This folder is the single source of truth for the in-app **Help & Docs**
section. Everything in `src/pages/docs/` is rendered to the user from the
sidebar.

## The rule

**Whenever you change a feature, update the docs in the same task.**

A task is not considered complete if the docs have not been updated alongside
the code. The planning agent appends a final "Update documentation" step to
every task plan. Treat it as part of the definition of done.

## What to update

When you ship a code change that adds, removes, or modifies a feature:

1. **Edit the matching module guide** in `guides/` so the steps, fields, and
   statuses still reflect what the user will actually see in the app. If a
   field was renamed, rename it here. If a status was added, add it to the
   `StatusTable`. If a workflow gained a new step, add it to the `Steps` list.

2. **Add a Changelog entry** in `guides/changelog.tsx`. Each entry needs:
   - The date the change shipped (today's date, ISO format `YYYY-MM-DD`).
   - The module(s) it touched, as a short tag list (e.g. `Procurement`,
     `Sales`, `Inventory`, `Finance`, `Reports`, `Master Data`, `Mobile`,
     `Administration`, `Dashboard`).
   - A one-line, user-facing description of what changed.

   New entries go at the top of the most recent month group. Create a new
   month group at the top of the list when the month rolls over.

3. **Cross-module changes** — if your change touches more than one module
   (e.g. a procurement change also affects GL postings), update *every*
   affected guide and tag the changelog entry with all relevant modules.

## What not to put in the docs

- Internal API endpoint names, database column names, or implementation
  details that the user will never see.
- Screenshots — the docs are intentionally text-only and live alongside the
  code.
- Versioned history of older releases prior to the initial documentation
  release. The Changelog starts from the day docs were introduced.

## Where things live

- `index.tsx` — the docs shell, route registration, and table of contents.
- `components.tsx` — shared primitives (`DocPage`, `Callout`, `FieldTable`,
  `StatusTable`, `Steps`, `Bullets`, `Code`).
- `guides/<module>.tsx` — one file per guide page. To add a new guide,
  create a new file here and register it in the TOC inside `index.tsx`.
- `guides/changelog.tsx` — the dated change log.

If you split a module into a new top-level guide, add it to the `GUIDES`
array in `index.tsx` so it appears in the sidebar TOC.
