# Forge ERP

## Overview

Forge ERP is a modern, multi-tenant SaaS ERP platform designed for mid-market businesses. It provides comprehensive solutions for purchasing and procurement, sales order management, inventory and warehouse operations, and fundamental financial postings. The project aims to deliver a robust and scalable ERP system that can efficiently manage core business processes for its users.

## User Preferences

I want to follow an iterative development approach, focusing on completing one module or feature at a time. Before making any significant architectural changes or implementing new features, please discuss the proposed approach with me. I prefer clear and concise explanations, avoiding overly technical jargon where possible. Ensure all code is well-documented and adheres to the established coding standards, including Zod validation rules (`z.string().email()` and `z.string().min(1)`).

## System Architecture

The system is built as a monorepo using pnpm workspaces, consisting of a React + Vite frontend (`forge-erp`) and an Express 5 REST API backend (`api-server`).

**UI/UX Decisions:**
The frontend utilizes React with Vite, styled using Tailwind CSS v4, shadcn/ui for components, and framer-motion for animations, providing a modern and responsive user experience. Navigation is handled by `wouter`.

**Technical Implementations:**
- **Authentication:** Clerk (Replit-managed, whitelabel) handles user authentication and authorization, including role-based access control.
- **API:** An Express 5 server serves as the REST API, using Clerk middleware for authentication.
- **Database:** PostgreSQL with Drizzle ORM is used for data persistence. Row-Level Security (RLS) is strictly enforced for multi-tenancy, ensuring data isolation between tenants. Application queries use a `forge_app` PostgreSQL role with no superuser privileges and enforced RLS.
- **Validation:** Zod v3 is used for data validation, specifically requiring `z.string().email()` for email validation and `z.string().min(1)` for non-empty strings.
- **API Codegen:** Orval generates API hooks from an OpenAPI specification (`lib/api-spec/openapi.yaml`).
- **Build System:** `esbuild` is used for CJS bundling.

**Feature Specifications:**
- **Multi-tenancy:** Core to the platform, with a `tenants` table and RLS policies ensuring data segregation.
- **Role-Based Access Control (RBAC):** Defined roles (`super_admin`, `tenant_admin`, `purchaser`, `warehouse`, `approver`, `accountant`, `viewer`) govern access.
- **Audit Logging:** A comprehensive `audit_logs` table records all system actions.
- **Onboarding Wizard:** A 5-step self-serve onboarding process for new tenants, including company details, structure, master data import, plan/payment setup, and team invitations.
- **Modules:**
    - **Procurement & Purchase Orders:** Covers requisitions, purchase orders, goods receipts, and returns.
    - **Sales Orders:** Manages quotations, sales orders, despatches, invoices, and credit notes.
    - **Inventory & Warehouse Operations:** Includes stock management, movements, adjustments, transfers, stocktakes, cycle counts, lot traceability, and serial number tracking.
    - **Finance / GL:** Journal ledger with manual entry, approve workflow (draft → posted), reverse, CSV + XLSX export. Trial balance with PDF (landscape, opening/period/closing columns) and CSV. GL account movements drill-down.
    - **Reports:** Full reports module with inventory (stock valuation, movements, slow-moving, stocktake variance), procurement (PO summary, supplier spend, GRN, goods-in-transit), and sales (revenue by period, top products, backorders, invoice aging with 5-bucket aging summary cards). All report tabs have CSV export.
    - **Dashboard:** Role-based KPI cards for admin, purchaser, warehouse, approver (+ recent decisions table), accountant (+ cash flow MTD inflow/outflow cards). Widgets with persistence and up/down reordering via localStorage.
    - **Mobile Picker PWA (`/picking`):** Installable, offline-capable PWA for warehouse pickers (tablets/phones) inside the forge-erp artifact. One-task-at-a-time guided picking with barcode scanning (`html5-qrcode`), photo capture, lot/serial/batch entry, short-pick reasons, voice readout (Web Speech API), and an IndexedDB outbox (`idb`) that queues mutations while offline and replays them on reconnect. Service worker scoped to `/picking/` does network-first for shell/API and stale-while-revalidate for static assets. Photos are uploaded directly to Replit Object Storage via presigned URLs (`/api/storage/uploads/request-url`). The Sales > Pick Slips tab embeds a real-time supervisor "Picking floor" board (10s polling) with KPIs and per-slip progress bars.
- **Picker API endpoints (api-server):** `GET /api/sales/pick-slips/{mine,queue}`, `GET /api/sales/pick-progress`, `POST /api/sales/pick-slips/:id/{assign,start,complete}`, `POST /api/sales/pick-slips/:id/lines/:lineId/{confirm,short-pick}`. All gated by `tenantUserMiddleware`/`tenantWriteMiddleware` and audit-logged. Slip auto-completes when every line is confirmed or short-picked.
- **Pick slip schema extensions:** `pickSlipsTable` adds `assignedToClerkId/Name/Email`, `startedAt`, `completedAt`, `priority`, `dueAt`. `pickSlipLinesTable` adds `locationLabel`, `barcode`, `confirmStatus` (pending/picked/short), `confirmedByClerkId/Name`, `confirmedAt`, `photoObjectPath`, `shortReason`, `shortNote`.
- **Database Schema Highlights:** Key tables include `tenants`, `users`, `tenant_memberships`, `warehouses`, `items`, `suppliers`, `customers`, `gl_accounts`, `purchase_requisitions`, `purchase_orders`, `inventory_stock`, `inventory_movements`, and `serial_numbers`.

## External Dependencies

- **Clerk:** For user authentication, authorization, and managing user identities.
- **PostgreSQL:** The primary database for all application data.
- **Stripe:** For payment processing, including customer and subscription management. The integration is optional and guarded by `isStripeConfigured()`. Webhooks require `STRIPE_WEBHOOK_SECRET`.
- **Orval:** Used for generating API client code from OpenAPI specifications.
- **Tailwind CSS v4:** A utility-first CSS framework for styling the frontend.
- **shadcn/ui:** A collection of reusable components for the frontend.
- **framer-motion:** A production-ready motion library for React.
- **Zod v3:** For schema validation.
- **multer:** Used for handling multipart/form-data, specifically for CSV uploads during onboarding.
- **Email (SMTP):** Transactional emails (onboarding welcome, teammate invitations, dispatch notifications) are delivered through `nodemailer` over SMTP. Configure via `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (`true` for 465/TLS), `SMTP_USER`, `SMTP_PASS`, and optional `SMTP_FROM`. When SMTP is not configured, sends are skipped with a logged warning and the surrounding flow (tenant creation, membership creation, etc.) is never rolled back. Onboarding invite emails link to `<FRONTEND_URL>/sign-up?email_address=<invitee>` so the Clerk `<SignUp>` form pre-fills the invitee's address; the lazy-claim path in `/auth/me` then activates the pending membership when the new user signs in.
- **Replit Object Storage (`@google-cloud/storage`):** Bucket-backed photo storage for picker pick-confirmation photos. Object paths are persisted on `pickSlipLinesTable.photoObjectPath` and served via `/api/storage{objectPath}`.
- **idb / html5-qrcode:** Picker PWA dependencies — IndexedDB wrapper for the offline outbox and barcode scanner runtime (lazy-loaded inside the picker only).
