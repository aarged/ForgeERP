# Forge ERP

## Overview

A modern, multi-tenant SaaS ERP platform for mid-market businesses. Covers purchasing/procurement, sales order management, inventory/warehouse operations, and basic financial postings.

## Artifacts

- **forge-erp** (React + Vite, path: `/`) — Main web application with Clerk auth, role-based access, and module navigation shell
- **api-server** (Express 5, path: `/api`) — REST API server with Clerk middleware and PostgreSQL

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend framework**: React + Vite (Tailwind CSS v4, shadcn/ui, framer-motion)
- **Routing**: wouter
- **Auth**: Clerk (Replit-managed, whitelabel)
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod v3 (must use `z.string().email()` NOT `z.email()`)
- **API codegen**: Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`)
- **Payments**: Stripe (graceful fallback if `STRIPE_SECRET_KEY` not set)
- **Build**: esbuild (CJS bundle)

## Database Schema

- `tenants` — Multi-tenant foundation (name, slug, status, planTier, businessDetails, stripeCustomerId, stripeSubscriptionId, deletedAt for soft-delete)
- `tenant_memberships` — User↔tenant relationship with role (super_admin, tenant_admin, purchaser, warehouse, approver, accountant, viewer)
- `users` — User profile cache
- `audit_logs` — Full audit trail for all actions
- `roles`, `permissions`, `role_permissions` — RBAC tables

## Database Roles & RLS

Two separate PostgreSQL roles:
- **postgres** (superuser, BYPASSRLS) — used for migrations, admin ops, `applyRLSPolicies()`, `adminPool`
- **forge_app** (no BYPASSRLS, no superuser) — used for ALL application queries via `pool`/`db`/`withTenantDb()`

RLS enforced via `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy on all tenant-scoped tables.
`withTenantDb(tenantId, callback)` sets `app.tenant_id` GUC per-transaction so RLS filters rows automatically.

Connection URLs:
- `DATABASE_URL` (runtime-managed) → postgres superuser, admin operations only
- `FORGE_APP_DB_URL` (shared env) → forge_app role, all application queries + RLS enforcement

## Auth & Roles

- Clerk is provisioned (Replit-managed)
- Roles: `super_admin`, `tenant_admin`, `purchaser`, `warehouse`, `approver`, `accountant`, `viewer`
- Row-level security enforced via `tenant_id` on all tables
- `requireAuth` middleware validates Clerk JWT; `requireRole` checks membership role

## API Endpoints

### Public / Auth
- `GET /api/healthz` — Health check
- `GET /api/auth/me` — Current user profile + tenant + role
- `PATCH /api/auth/me` — Update current user profile
- `GET /api/tenants/current` — Current tenant info
- `GET /api/tenants/current/members` — Tenant member list

### Super-Admin (super_admin role required)
- `GET /api/admin/kpi` — Platform KPI counts (total/active/trial/suspended/stripe tenants)
- `GET /api/admin/tenants` — List all tenants with member counts
- `POST /api/admin/tenants` — Create tenant (name, email, planTier, status, currency)
- `GET /api/admin/tenants/:id` — Tenant detail
- `PATCH /api/admin/tenants/:id` — Update tenant (name, status, planTier, email, currency)
- `DELETE /api/admin/tenants/:id` — Soft-delete tenant (sets deletedAt, suspends)
- `POST /api/admin/tenants/:id/stripe-sync` — Create Stripe customer for tenant
- `GET /api/admin/tenants/:id/invoices` — List Stripe invoices for tenant
- `GET /api/admin/audit-logs` — Global audit log

### Stripe
- `POST /api/webhooks/stripe` — Stripe webhook handler (raw body, before express.json)

## Stripe Integration

Stripe is optional — all code is guarded by `isStripeConfigured()`. Set `STRIPE_SECRET_KEY` environment secret to enable. Webhooks require `STRIPE_WEBHOOK_SECRET`.

## Key Commands

- `pnpm run typecheck` — Full typecheck across all packages
- `pnpm run build` — Typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks from OpenAPI spec
- `pnpm --filter @workspace/db run push-force` — Push DB schema changes (dev only, bypasses prompts)
- `pnpm --filter @workspace/db run build` — Rebuild db package types after schema changes

## Frontend Pages

- `/` — Marketing landing page (public) + redirect to /dashboard when signed in
- `/sign-in/*?` — Clerk sign-in page (custom branded)
- `/sign-up/*?` — Clerk sign-up page (custom branded)
- `/dashboard` — Main app dashboard (protected)
- `/settings` — User profile settings (protected)
- `/procurement`, `/sales`, `/inventory`, `/finance` — Module placeholders (protected)
- `/super-admin` — Super admin dashboard: KPI bar, tenant table w/ search/filter, create tenant dialog, tenant detail sheet with Stripe invoices, row actions (suspend/unsuspend/plan change/delete)

## Important Zod Notes

- Zod version is v3 (not v4) — use `z.string().email()` not `z.email()`
- Use `z.string().min(1)` not `z.string().nonempty()`
- Stripe-replit-sync `MigrationConfig` only accepts `{ databaseUrl, ssl?, logger? }` — no `schema` field

## Module Build Status

- [x] Task 1: Foundation, Auth & App Shell
- [x] Task 2: Super-Admin Dashboard & Tenant Management
- [ ] Task 3: Tenant Onboarding Wizard
- [ ] Task 4: Master Data Management
- [ ] Task 5: Procurement & Purchase Orders Module
- [ ] Task 6: Sales Orders Module
- [ ] Task 7: Inventory & Warehouse Operations
- [ ] Task 8: Mobile Warehouse Picking App (PWA)
- [ ] Task 9: GL Financial Integration & Reports

See individual tasks in `.local/tasks/` for detailed specifications.
