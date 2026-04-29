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
- `onboarding_sessions` — Progress persistence for the 5-step wizard, keyed by clerkUserId (NOT tenantId — user has no tenant until complete)
- `warehouses` — Per-tenant warehouse/location records with full address; enhanced fields (code, isDefault, isActive, notes)
- `warehouse_locations` — Sub-locations within warehouses (aisle/rack/bin, parentId for nesting, locationType)
- `departments` — Per-tenant department records (name, code)
- `items` — Inventory items/products per tenant; enhanced (code, name, itemType, trackingType, packSize, barcode, unitCost, salesPrice, category, imageUrl, hasVariants, notes)
- `item_variants` — Variants of items (size/color/etc.)
- `item_attributes` — Free-form key-value attributes per item
- `item_locations` — Item/variant inventory per warehouse location with qty, lot, serial, batch, expiry
- `item_cross_references` — External barcodes/codes (e.g. EAN, UPC, supplier PN)
- `suppliers` — Supplier master; enhanced (taxId, abn, legalName, website, delivery address, paymentTerms, currency, pricingTier, creditLimit, onTimeDeliveryPct, fillRatePct, notes)
- `supplier_contacts` — Contacts per supplier (name, role, email, phone, isPrimary)
- `customers` — Customer master; enhanced (taxId, abn, legalName, billing+shipping address, creditLimit, paymentTerms, currency, pricingTier, notes)
- `customer_contacts` — Contacts per customer (name, role, email, phone, isPrimary)
- `gl_accounts` — GL Chart of Accounts (code, name, accountType: asset/liability/equity/revenue/expense, parentId for tree, taxCode, isPosting, glTemplate)
- `approval_workflows` — Named approval workflow templates (name, entityType, isActive) per tenant
- `approval_steps` — Steps within a workflow (stepOrder, approverRole, approverUserId, requireAll, autoApprove, maxAmount)
- `approval_decisions` — Audit of each approver action (decision: approved/rejected/returned, comments, actedAt)
- `purchase_requisitions` — Purchase requisition headers (code REQ-XXXXXX, title, priority, status lifecycle, requesterUserId, departmentId, warehouseId, authorityLimit)
- `requisition_lines` — Line items on a requisition (itemCode, description, qty, unitPrice, taxPct, accountCode)
- `purchase_orders` — PO headers (code PO-XXXXXX, status, supplierId, currency, expectedDate, fromRequisitionId)
- `po_lines` — PO line items (itemCode, description, qty, unitPrice, taxPct, receivedQty, lineType: stock/expense/service/asset)
- `po_receipts` — Goods receipt headers (code GR-XXXXXX, warehouseId, receivedBy)
- `receipt_lines` — Receipt line items with lot/serial/batch capture (lotNumber, serialNumber, batchNumber, expiryDate)
- `po_returns` — Return-to-supplier headers (returnReason)
- `return_lines` — Return line items (returnedQty)
- `inventory_stock` — Current stock on hand per item/warehouse (onHand, reserved, avgCost)
- `inventory_movements` — Inventory transaction ledger (movementType, qty, unitCost, reference, lotNumber, serialNumber, toWarehouseId, toLocationId, adjReason, issueAccountId, glPostingId)
- `cost_layers` — FIFO/LIFO cost layers per item/warehouse/lot (qty, unitCost, remainingQty, movementId)
- `lot_numbers` — Lot master (lotNumber, itemId, warehouseId, qtyOnHand, expiryDate, status)
- `stocktake_runs` — Physical count run headers (code, warehouseId, locationId, status, countedAt, postedAt)
- `stocktake_lines` — Lines within a stocktake run (itemId, systemQty, countedQty, varianceQty, status)
- `cycle_count_tasks` — Cycle count assignments (code, warehouseId, assignedTo, dueDate, status)
- `cycle_count_lines` — Lines within a cycle count task (itemId, locationId, systemQty, countedQty, varianceQty)
- `inventory_adjustments` — Manual stock adjustment records (adjustmentType, qty, unitCost, reason, glAccountId)
- `inventory_transfers` — Inter-warehouse transfer records with transit-state lifecycle (status: in_transit/received/cancelled; fromWarehouseId/toWarehouseId, quantity, linked outbound movement)
- `serial_numbers` — Serial number master per tenant (serialNumber, itemId, warehouseId, locationId, lotNumber, status: available/sold/scrapped/quarantine/in_transit, notes)
- `landed_cost_allocations` — Landed cost apportionment to receipt lines (landedCostType, amount, allocationBasis)
- `gl_postings` — GL journal entry headers (postingDate, reference, sourceType: po_receipt/return/inventory_adjustment/inventory_issue, description)
- `gl_posting_lines` — Journal entry lines (accountCode, debit, credit, description)
- `items.costingMethod` — Per-item costing method: fifo | avco | standard (default avco)

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
- `POST /api/admin/tenants/:id/stripe-subscription` — Create or update Stripe subscription (set STRIPE_PRICE_STARTER/GROWTH/ENTERPRISE env vars)
- `GET /api/admin/tenants/:id/invoices` — List Stripe invoices for tenant
- `GET /api/admin/tenants/:id/members` — List a tenant's members (active and inactive)
- `PATCH /api/admin/tenants/:id/members/:membershipId` — Update a member's role and/or active status
- `GET /api/admin/audit-logs` — Global audit log

### Onboarding (signed-in users without a tenant)
- `GET /api/onboarding/session` — Get current user's onboarding session progress (keyed by clerkUserId, persisted in `onboarding_sessions` table)
- `PUT /api/onboarding/session` — Save/update onboarding session progress (currentStep + data JSON)
- `POST /api/onboarding/validate-abn` — Validate a tax ID/ABN format for AU/US/UK
- `POST /api/onboarding/upload-csv` — Multipart CSV upload for items/suppliers/customers (multer)
- `POST /api/onboarding/load-sample` — Return built-in sample data (items/suppliers/customers)
- `POST /api/onboarding/setup-payment` — Create Stripe SetupIntent for card collection (503 if Stripe not configured)
- `POST /api/onboarding/complete` — Full tenant creation with warehouses/departments/master data bulk insert/invites. Creates tenant with status="active".
- `POST /api/onboarding/create-tenant` — Legacy backward-compat endpoint. Creates a tenant for the current Clerk user, makes them `tenant_admin`, marks `onboardingCompletedAt`, and dispatches teammate invites via Clerk's Invitations API (real, branded email + tokenized accept link). Each invite is also persisted as a pending membership (clerkId = `pending:<email>`, isActive = "false") so admins can resend later. Per-invite delivery failures are logged and reported in the response (`invites[]`, `invitesSent`, `invitesAttempted`) but do not roll back tenant creation. Idempotent: returns 200 + `alreadyOnboarded: true` if the user already has a membership. Backfills `tenantId` into Clerk publicMetadata.
- **Acceptance path**: `GET /api/auth/me` lazily claims any pending invites for the calling user. When an invitee finishes signing up via the Clerk invitation link, their first `/auth/me` call matches the `pending:<email>` placeholder to their real Clerk id, flips the membership to active, writes a `tenant.invite_accepted` audit log, and backfills their Clerk `publicMetadata.tenantId`.

### Stripe
- `POST /api/webhooks/stripe` — Stripe webhook handler (raw body, before express.json)

## Stripe Integration

Stripe is optional — all code is guarded by `isStripeConfigured()` which returns `true` only if Stripe actually initialised successfully at startup (credential retrieval succeeded). Use `canAttemptStripeInit()` to check if the Replit connectors env vars are present (for the startup attempt). Connect via the Replit Integrations tab. Webhooks require `STRIPE_WEBHOOK_SECRET`.

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
- `/procurement` — Full Procurement & Purchase Orders module (9 tabs: Dashboard, Requisitions, Purchase Orders, Goods Receipts, Returns, Inventory, GL Postings, Workflows, Reports)
- `/sales` — Full Sales Orders module (8 tabs: Quotations, Sales Orders, Despatches, Invoices, Credit Notes, RMA, Pick Slips, Allocations). Covers quotation → SO → pick slip → despatch → invoice lifecycle, RMA/credit notes, ATP allocation, GL postings.
- `/inventory` — Full Inventory & Warehouse Operations module (10 tabs: Stock Dashboard, Movement Log, Adjustments, Transfers, Issues, Stocktake, Cycle Counts, Lot Traceability, Serial Numbers, Repack/Build). Features: multi-warehouse stock position with on-order/in-transit availability, manual adjustments with automatic GL postings, per-item costing method (FIFO/AVCO/Standard), transit-state inter-warehouse transfers with Receive workflow, stock issues to GL accounts, physical stocktake runs with variance posting, cycle count task assignment, lot traceability with forward+backward trace, serial number register with full movement trace, repack/build dual-panel posting, CSV export of stock positions.
- `/finance` — Module placeholder (protected)
- `/super-admin` — Super admin dashboard: KPI bar, tenant table w/ search/filter, create tenant dialog, tenant detail sheet with Stripe invoices, row actions (suspend/unsuspend/plan change/delete)
- `/pending` — Shown when a signed-in user has no tenant; CTA to start onboarding
- `/onboarding` — 5-step self-serve wizard (Company Details → Company Structure → Master Data Import → Plan & Payment → Team Setup). Features: progress persistence via session API, ABN/tax ID validation, CSV import with template download, sample data loading, Stripe Elements (graceful fallback), warehouse/department setup with GL template, up to 25 team invites, Quick Start Tour on completion. Redirects to `/dashboard` when the user already has a tenant.

## Important Zod Notes

- Zod version is v3 (not v4) — use `z.string().email()` not `z.email()`
- Use `z.string().min(1)` not `z.string().nonempty()`
- Stripe-replit-sync `MigrationConfig` only accepts `{ databaseUrl, ssl?, logger? }` — no `schema` field

## Module Build Status

- [x] Task 1: Foundation, Auth & App Shell
- [x] Task 2: Super-Admin Dashboard & Tenant Management
- [x] Task 3: Tenant Onboarding Wizard
- [ ] Task 4: Master Data Management
- [x] Task 5: Procurement & Purchase Orders Module
- [x] Task 6: Sales Orders Module
- [x] Task 7: Inventory & Warehouse Operations
- [ ] Task 8: Mobile Warehouse Picking App (PWA)
- [ ] Task 9: GL Financial Integration & Reports

See individual tasks in `.local/tasks/` for detailed specifications.
