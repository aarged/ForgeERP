---
name: Bulk SET importers (delta-from-snapshot)
description: Pitfalls when an importer SETS levels by computing delta = target − current and posting one adjustment.
---

# Bulk "set level" importers

Forge ERP stock/value importers that SET a quantity work by computing
`delta = target − current` and posting the deltas through the adjustment/movement
machinery as ONE document. Two non-obvious constraints:

- **Duplicate buckets must chain off running state, not the pre-import snapshot.**
  If you read `current` once per row from the DB snapshot and the same bucket
  (item/warehouse/location/lot) appears in multiple CSV rows, every delta is
  computed from the same stale `current`, so cumulative application overshoots.
  Keep an in-memory `Map<bucketKey, runningQty>`: first touch reads the DB, later
  touches read the map. Last row then wins and the final level is correct.
  **Why:** deltas are applied in order against live DB rows, so the delta math
  must mirror that same sequential progression.

- **Validate CSV numerics server-side, send raw strings over the wire.**
  Send `qtyOnHand` as a string in the request body and parse/validate on the
  backend so a bad value becomes a per-row error instead of aborting the whole
  request. Coercing invalid numbers to 0 in the frontend (or `z.coerce.number()`,
  which turns `"" → 0`) silently writes a zero set instead of reporting the error.
  **How to apply:** mirror the not-found error handling — collect `{row, code, error}`
  per row, never throw for a single bad row.
