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
- **Validation**: Zod (zod/v4), drizzle-zod
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Database Schema

- `tenants` — Multi-tenant foundation table (name, slug, status, plan tier, business details, Stripe IDs)
- `tenant_memberships` — User↔tenant relationship with role (super_admin, tenant_admin, purchaser, warehouse, approver, accountant, viewer)
- `users` — User profile cache
- `audit_logs` — Full audit trail for all actions
- `roles`, `permissions`, `role_permissions` — RBAC tables

## Database Roles & RLS

Two separate PostgreSQL roles:
- **postgres** (superuser, BYPASSRLS) — used for migrations, admin ops, `applyRLSPolicies()`, `adminPool`
- **forge_app** (no BYPASSRLS, no superuser) — used for ALL application queries via `pool`/`db`/`withTenantDb()`

RLS is enforced via `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy on all tenant-scoped tables.
`withTenantDb(tenantId, callback)` sets `app.tenant_id` GUC per-transaction so RLS filters rows automatically.

Connection URLs:
- `DATABASE_URL` (runtime-managed) → postgres superuser, admin operations only
- `FORGE_APP_DB_URL` (shared env) → forge_app role, all application queries + RLS enforcement

## Auth & Roles

- Clerk is provisioned (Replit-managed)
- Roles: `super_admin`, `tenant_admin`, `purchaser`, `warehouse`, `approver`, `accountant`, `viewer`
- Row-level security enforced via `tenant_id` on all tables
- `requireAuth` middleware (`artifacts/api-server/src/middlewares/requireAuth.ts`) validates Clerk JWT

## API Endpoints

- `GET /api/healthz` — Health check
- `GET /api/auth/me` — Current user profile + tenant + role
- `PATCH /api/auth/me` — Update current user profile
- `GET /api/tenants/current` — Current tenant info
- `GET /api/tenants/current/members` — Tenant member list

## Key Commands

- `pnpm run typecheck` — Full typecheck across all packages
- `pnpm run build` — Typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — Push DB schema changes (dev only)

## Frontend Pages

- `/` — Marketing landing page (public) + redirect to /dashboard when signed in
- `/sign-in/*?` — Clerk sign-in page (custom branded)
- `/sign-up/*?` — Clerk sign-up page (custom branded)
- `/dashboard` — Main app dashboard (protected)
- `/settings` — User profile settings (protected)
- `/procurement`, `/sales`, `/inventory`, `/finance` — Module placeholders (protected)
- `/super-admin` — Super admin area (super_admin role only)

## Module Build Status

- [x] Task 1: Foundation, Auth & App Shell
- [ ] Task 2: Super-Admin Dashboard & Tenant Management
- [ ] Task 3: Tenant Onboarding Wizard
- [ ] Task 4: Master Data Management
- [ ] Task 5: Procurement & Purchase Orders Module
- [ ] Task 6: Sales Orders Module
- [ ] Task 7: Inventory & Warehouse Operations
- [ ] Task 8: Mobile Warehouse Picking App (PWA)
- [ ] Task 9: GL Financial Integration & Reports

See individual tasks in `.local/tasks/` for detailed specifications.
