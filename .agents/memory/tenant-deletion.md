---
name: Tenant deletion is soft-delete only
description: Why "deleted" tenants still show data in raw SQL, and how to truly wipe them.
---

# Tenant deletion in Forge ERP is soft-delete only

The `DELETE /admin/tenants/:id` handler does NOT remove rows. It stamps
`tenants.deleted_at = now()` and `status = 'suspended'`. The app hides such
tenants (queries filter `isNull(deletedAt)`), but the tenant row and ALL child
data (items, invoices, lines, POs, stock, memberships) physically remain.

**Why this matters:** users inspecting the raw SQL database see "deleted" data
still there and assume deletion failed or leaked to another environment. It did
not — it's just soft delete.

**How to truly wipe:** every FK referencing `tenants` is `ON DELETE CASCADE`
(verified via `pg_constraint.confdeltype = 'c'`). A real
`DELETE FROM tenants WHERE id IN (...)` removes all child rows across ~60 tables
automatically. Soft delete never triggers the cascade because the tenant row is
never actually deleted.

**Caution:** `tenant_memberships` also cascades, so hard-deleting a tenant
removes its memberships too — don't delete the tenant that holds the global_admin
membership you rely on for login.
