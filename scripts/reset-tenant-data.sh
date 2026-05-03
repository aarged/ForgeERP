#!/bin/bash
# Reset all tenant data (dev only).
#
# Wipes every tenant-scoped row by deleting from `tenants` (cascades to all
# tenant FKs), then truncates platform-level tables that reference tenants
# loosely (audit_logs, onboarding_sessions, users) so the system is fully
# empty. Schema, RLS policies, and enum/role definitions are untouched.
#
# Usage: bash scripts/reset-tenant-data.sh
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

echo "Counts BEFORE reset:"
psql "$DATABASE_URL" -At -c "SELECT 'tenants=' || count(*) FROM tenants;"
psql "$DATABASE_URL" -At -c "SELECT 'tenant_memberships=' || count(*) FROM tenant_memberships;"
psql "$DATABASE_URL" -At -c "SELECT 'audit_logs=' || count(*) FROM audit_logs;"
psql "$DATABASE_URL" -At -c "SELECT 'onboarding_sessions=' || count(*) FROM onboarding_sessions;"
psql "$DATABASE_URL" -At -c "SELECT 'users=' || count(*) FROM users;"

echo ""
echo "Deleting all tenants (cascades to all tenant-scoped tables) ..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM tenants;
TRUNCATE TABLE audit_logs RESTART IDENTITY;
TRUNCATE TABLE onboarding_sessions RESTART IDENTITY;
TRUNCATE TABLE users RESTART IDENTITY;
COMMIT;
SQL

echo ""
echo "Counts AFTER reset:"
psql "$DATABASE_URL" -At -c "SELECT 'tenants=' || count(*) FROM tenants;"
psql "$DATABASE_URL" -At -c "SELECT 'tenant_memberships=' || count(*) FROM tenant_memberships;"
psql "$DATABASE_URL" -At -c "SELECT 'audit_logs=' || count(*) FROM audit_logs;"
psql "$DATABASE_URL" -At -c "SELECT 'onboarding_sessions=' || count(*) FROM onboarding_sessions;"
psql "$DATABASE_URL" -At -c "SELECT 'users=' || count(*) FROM users;"

echo ""
echo "Done."
