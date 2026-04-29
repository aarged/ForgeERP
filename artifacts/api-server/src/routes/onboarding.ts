import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  adminPool,
  tenantsTable,
  tenantMembershipsTable,
  onboardingSessionsTable,
  warehousesTable,
  departmentsTable,
  itemsTable,
  suppliersTable,
  customersTable,
} from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { z } from "zod";
import { createClerkClient } from "@clerk/express";
import multer from "multer";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { writeAuditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { isStripeConfigured, getUncachableStripeClient } from "../lib/stripe";
import { sendEmail, buildWelcomeEmail } from "../lib/email";
import type { Request, Response } from "express";

const router: IRouter = Router();
const adminDb = drizzle(adminPool, { schema });

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Origin helpers ─────────────────────────────────────────────────────────────

function buildAllowedOrigins(): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try { out.add(new URL(raw).origin); } catch { /* ignore */ }
  };
  add(process.env.FRONTEND_URL);
  for (const v of (process.env.FRONTEND_URLS ?? "").split(",")) add(v.trim());
  if (process.env.REPLIT_DEV_DOMAIN) add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  return [...out];
}

function resolveInviteRedirectUrl(req: Request): string | undefined {
  const allowed = buildAllowedOrigins();
  const candidates: string[] = [];
  if (req.headers.origin) candidates.push(req.headers.origin as string);
  if (req.headers.referer) {
    try { candidates.push(new URL(req.headers.referer as string).origin); } catch { /* ignore */ }
  }
  let chosenOrigin: string | undefined;
  for (const c of candidates) {
    if (allowed.includes(c)) { chosenOrigin = c; break; }
  }
  if (!chosenOrigin && allowed.length > 0 && process.env.FRONTEND_URL) {
    try { chosenOrigin = new URL(process.env.FRONTEND_URL).origin; } catch { /* ignore */ }
  }
  if (!chosenOrigin) return undefined;
  try { return new URL("/sign-up", chosenOrigin).toString(); } catch { return undefined; }
}

// ── Slug helpers ───────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

async function ensureUniqueSlug(base: string): Promise<string> {
  const root = base || "company";
  let slug = root;
  let i = 1;
  while (true) {
    const existing = await adminDb.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.slug, slug)).limit(1);
    if (existing.length === 0) return slug;
    slug = `${root}-${i++}`;
  }
}

function pendingClerkIdForEmail(email: string): string {
  return `pending:${email.toLowerCase()}`;
}

// ── CSV parser ─────────────────────────────────────────────────────────────────

function parseCsvBuffer(buffer: Buffer): string[][] {
  const text = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    const cols: string[] = [];
    let current = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === "," && !inQuote) {
        cols.push(current.trim()); current = "";
      } else {
        current += ch;
      }
    }
    cols.push(current.trim());
    return cols;
  });
}

// ── ABN validator ──────────────────────────────────────────────────────────────

function validateAbn(raw: string): boolean {
  const digits = raw.replace(/\s/g, "");
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const adjusted = [Number(digits[0]) - 1, ...digits.slice(1).split("").map(Number)];
  const sum = weights.reduce((s, w, i) => s + w * adjusted[i]!, 0);
  return sum % 89 === 0;
}

// ── Sample data ────────────────────────────────────────────────────────────────

const SAMPLE_ITEMS = [
  { code: "ITEM-001", name: "Office Chair", description: "Ergonomic office chair", unitOfMeasure: "EA", unitCost: "299.00", category: "Furniture" },
  { code: "ITEM-002", name: "Standing Desk", description: "Height-adjustable desk", unitOfMeasure: "EA", unitCost: "599.00", category: "Furniture" },
  { code: "ITEM-003", name: "Laptop", description: "Business laptop 15\"", unitOfMeasure: "EA", unitCost: "1200.00", category: "Electronics" },
  { code: "ITEM-004", name: "USB-C Hub", description: "7-port USB-C hub", unitOfMeasure: "EA", unitCost: "49.99", category: "Electronics" },
  { code: "ITEM-005", name: "Printer Paper A4", description: "A4 80gsm paper 500 sheets", unitOfMeasure: "REAM", unitCost: "8.50", category: "Stationery" },
];

const SAMPLE_SUPPLIERS = [
  { code: "SUP-001", name: "Acme Supplies Co.", email: "orders@acmesupplies.com", phone: "+1 555 0100", contactName: "Jane Smith", paymentTerms: "Net 30", currency: "USD" },
  { code: "SUP-002", name: "Global Parts Ltd", email: "sales@globalparts.com", phone: "+44 20 7946 0958", contactName: "John Brown", paymentTerms: "Net 60", currency: "GBP" },
  { code: "SUP-003", name: "Tech Components Inc", email: "info@techcomp.com", phone: "+1 555 0200", contactName: "Alice Lee", paymentTerms: "Net 30", currency: "USD" },
];

const SAMPLE_CUSTOMERS = [
  { code: "CUST-001", name: "Northwind Corp", email: "purchasing@northwind.com", phone: "+1 555 0300", contactName: "Bob Johnson", creditLimit: "50000.00", paymentTerms: "Net 30", currency: "USD" },
  { code: "CUST-002", name: "Contoso Ltd", email: "ap@contoso.com", phone: "+1 555 0400", contactName: "Carol White", creditLimit: "25000.00", paymentTerms: "Net 45", currency: "USD" },
  { code: "CUST-003", name: "Fabrikam Industries", email: "orders@fabrikam.com", phone: "+1 555 0500", contactName: "Dan Miller", creditLimit: "75000.00", paymentTerms: "Net 30", currency: "USD" },
];

// ── Schemas ────────────────────────────────────────────────────────────────────

const inviteRoleEnum = z.enum(["tenant_admin", "purchaser", "warehouse", "approver", "accountant", "viewer"]);

const warehouseInputSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(20).optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  isDefault: z.boolean().optional(),
});

const departmentInputSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(20).optional(),
});

const completeOnboardingSchema = z.object({
  step1: z.object({
    companyName: z.string().min(1).max(200),
    tradingName: z.string().max(200).optional(),
    legalName: z.string().max(200).optional(),
    taxId: z.string().max(50).optional(),
    phone: z.string().max(50).optional(),
    email: z.string().email().optional(),
    website: z.string().max(300).optional(),
    addressLine1: z.string().max(200).optional(),
    addressLine2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(100).optional(),
    fiscalYearStart: z.number().int().min(1).max(12).optional(),
    currency: z.string().length(3).optional(),
    timezone: z.string().max(80).optional(),
    industryType: z.string().max(100).optional(),
  }),
  step2: z.object({
    warehouses: z.array(warehouseInputSchema).max(20).optional(),
    departments: z.array(departmentInputSchema).max(50).optional(),
    glTemplate: z.enum(["simple", "standard", "advanced"]).optional(),
  }).optional(),
  step3: z.object({
    items: z.array(z.object({
      code: z.string().max(50),
      name: z.string().max(200),
      description: z.string().max(500).optional(),
      unitOfMeasure: z.string().max(20).optional(),
      unitCost: z.string().max(30).optional(),
      category: z.string().max(100).optional(),
    })).max(1000).optional(),
    suppliers: z.array(z.object({
      code: z.string().max(50),
      name: z.string().max(200),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      contactName: z.string().max(200).optional(),
      paymentTerms: z.string().max(50).optional(),
      currency: z.string().max(3).optional(),
    })).max(500).optional(),
    customers: z.array(z.object({
      code: z.string().max(50),
      name: z.string().max(200),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      contactName: z.string().max(200).optional(),
      creditLimit: z.string().max(30).optional(),
      paymentTerms: z.string().max(50).optional(),
      currency: z.string().max(3).optional(),
    })).max(500).optional(),
  }).optional(),
  step4: z.object({
    planTier: z.enum(["starter", "growth", "enterprise"]).optional(),
    stripePaymentMethodId: z.string().optional(),
  }).optional(),
  step5: z.object({
    invites: z.array(z.object({
      email: z.string().email(),
      role: inviteRoleEnum,
    })).max(25).optional(),
  }).optional(),
});

const sessionUpdateSchema = z.object({
  currentStep: z.number().int().min(1).max(5).optional(),
  data: z.record(z.unknown()).optional(),
});

// ── GET /onboarding/session ────────────────────────────────────────────────────

router.get(
  "/onboarding/session",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const clerkId = (req as AuthenticatedRequest).clerkUserId;
    const [session] = await adminDb
      .select()
      .from(onboardingSessionsTable)
      .where(eq(onboardingSessionsTable.clerkUserId, clerkId))
      .limit(1);

    if (!session) {
      res.json({ currentStep: 1, data: {}, completedAt: null });
      return;
    }
    res.json({
      currentStep: session.currentStep,
      data: session.data ?? {},
      completedAt: session.completedAt?.toISOString() ?? null,
    });
  },
);

// ── PUT /onboarding/session ────────────────────────────────────────────────────

router.put(
  "/onboarding/session",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const clerkId = (req as AuthenticatedRequest).clerkUserId;
    const parsed = sessionUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const { currentStep, data } = parsed.data;

    const [existing] = await adminDb
      .select()
      .from(onboardingSessionsTable)
      .where(eq(onboardingSessionsTable.clerkUserId, clerkId))
      .limit(1);

    if (existing) {
      const mergedData = { ...(existing.data as object ?? {}), ...(data ?? {}) };
      const [updated] = await adminDb
        .update(onboardingSessionsTable)
        .set({ currentStep: currentStep ?? existing.currentStep, data: mergedData })
        .where(eq(onboardingSessionsTable.clerkUserId, clerkId))
        .returning();
      res.json({ currentStep: updated!.currentStep, data: updated!.data });
    } else {
      const [created] = await adminDb
        .insert(onboardingSessionsTable)
        .values({ clerkUserId: clerkId, currentStep: currentStep ?? 1, data: data ?? {} })
        .returning();
      res.json({ currentStep: created!.currentStep, data: created!.data });
    }
  },
);

// ── POST /onboarding/validate-abn ─────────────────────────────────────────────

router.post(
  "/onboarding/validate-abn",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { taxId, country } = req.body as { taxId?: string; country?: string };
    if (!taxId || typeof taxId !== "string") {
      res.status(400).json({ error: "taxId is required" });
      return;
    }
    const trimmed = taxId.trim();
    if (!trimmed) {
      res.status(400).json({ error: "taxId is empty" });
      return;
    }

    let valid = true;
    let message = "Valid";

    const countryUpper = (country ?? "").toUpperCase();

    if (countryUpper === "AU" || countryUpper === "AUSTRALIA") {
      valid = validateAbn(trimmed);
      message = valid ? "Valid ABN" : "Invalid ABN — must be 11 digits and pass the ABN check";
    } else if (countryUpper === "US" || countryUpper === "USA") {
      valid = /^\d{2}-?\d{7}$/.test(trimmed);
      message = valid ? "Valid EIN" : "Invalid EIN — expected format XX-XXXXXXX";
    } else if (countryUpper === "GB" || countryUpper === "UK") {
      valid = /^(GB)?\d{9}(\d{3})?$/.test(trimmed.replace(/\s/g, ""));
      message = valid ? "Valid VAT number" : "Invalid UK VAT number";
    } else {
      // Generic: at least 3 chars
      valid = trimmed.length >= 3;
      message = valid ? "Format accepted" : "Tax ID is too short";
    }

    res.json({ valid, message, taxId: trimmed });
  },
);

// ── POST /onboarding/upload-csv ───────────────────────────────────────────────

router.post(
  "/onboarding/upload-csv",
  requireAuth,
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const csvType = (req.body as { csvType?: string }).csvType ?? "items";
    if (!["items", "suppliers", "customers"].includes(csvType)) {
      res.status(400).json({ error: "csvType must be items, suppliers, or customers" });
      return;
    }

    const rows = parseCsvBuffer(file.buffer);
    if (rows.length < 2) {
      res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      return;
    }

    const [headerRow, ...dataRows] = rows;
    const headers = (headerRow ?? []).map((h) => h.toLowerCase().replace(/\s+/g, "_"));

    const col = (name: string) => {
      const idx = headers.indexOf(name);
      return idx >= 0 ? (r: string[]) => r[idx]?.trim() ?? "" : () => "";
    };

    const errors: string[] = [];
    let parsed: Record<string, string>[] = [];

    if (csvType === "items") {
      const getCode = col("code");
      const getName = col("name");
      parsed = dataRows.map((r, i) => {
        const code = getCode(r);
        const name = getName(r);
        if (!code) errors.push(`Row ${i + 2}: code is required`);
        if (!name) errors.push(`Row ${i + 2}: name is required`);
        return {
          code,
          name,
          description: col("description")(r),
          unitOfMeasure: col("unit_of_measure")(r) || col("uom")(r),
          unitCost: col("unit_cost")(r) || col("cost")(r),
          category: col("category")(r),
        };
      });
    } else if (csvType === "suppliers") {
      const getCode = col("code");
      const getName = col("name");
      parsed = dataRows.map((r, i) => {
        const code = getCode(r);
        const name = getName(r);
        if (!code) errors.push(`Row ${i + 2}: code is required`);
        if (!name) errors.push(`Row ${i + 2}: name is required`);
        return {
          code, name,
          email: col("email")(r),
          phone: col("phone")(r),
          address: col("address")(r),
          contactName: col("contact_name")(r) || col("contact")(r),
          paymentTerms: col("payment_terms")(r) || col("terms")(r),
          currency: col("currency")(r) || "USD",
        };
      });
    } else {
      const getCode = col("code");
      const getName = col("name");
      parsed = dataRows.map((r, i) => {
        const code = getCode(r);
        const name = getName(r);
        if (!code) errors.push(`Row ${i + 2}: code is required`);
        if (!name) errors.push(`Row ${i + 2}: name is required`);
        return {
          code, name,
          email: col("email")(r),
          phone: col("phone")(r),
          address: col("address")(r),
          contactName: col("contact_name")(r) || col("contact")(r),
          creditLimit: col("credit_limit")(r) || col("limit")(r),
          paymentTerms: col("payment_terms")(r) || col("terms")(r),
          currency: col("currency")(r) || "USD",
        };
      });
    }

    res.json({
      csvType,
      rows: parsed,
      rowCount: parsed.length,
      errors: errors.slice(0, 20),
      hasErrors: errors.length > 0,
    });
  },
);

// ── POST /onboarding/load-sample ──────────────────────────────────────────────

router.post(
  "/onboarding/load-sample",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    res.json({
      items: SAMPLE_ITEMS,
      suppliers: SAMPLE_SUPPLIERS,
      customers: SAMPLE_CUSTOMERS,
    });
  },
);

// ── POST /onboarding/setup-payment ────────────────────────────────────────────

router.post(
  "/onboarding/setup-payment",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    if (!isStripeConfigured()) {
      res.status(503).json({
        error: "Stripe is not configured",
        code: "STRIPE_NOT_CONFIGURED",
        hint: "Set STRIPE_SECRET_KEY to enable billing",
      });
      return;
    }

    try {
      const stripe = await getUncachableStripeClient();
      const setupIntent = await stripe.setupIntents.create({
        usage: "off_session",
        automatic_payment_methods: { enabled: true },
        metadata: { clerkUserId: (req as AuthenticatedRequest).clerkUserId },
      });
      res.json({ clientSecret: setupIntent.client_secret });
    } catch (err) {
      logger.error({ err }, "Failed to create Stripe SetupIntent");
      res.status(500).json({ error: "Failed to initialize payment" });
    }
  },
);

// ── POST /onboarding/complete ─────────────────────────────────────────────────

router.post(
  "/onboarding/complete",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const clerkId = (req as AuthenticatedRequest).clerkUserId;

    const parsed = completeOnboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { step1, step2, step3, step4, step5 } = parsed.data;

    // Enforce payment method for paid plans when Stripe is configured
    const requestedPlan = step4?.planTier ?? "starter";
    if (isStripeConfigured() && requestedPlan !== "starter" && !step4?.stripePaymentMethodId) {
      res.status(400).json({
        error: "A payment method is required to activate a paid plan.",
        code: "PAYMENT_METHOD_REQUIRED",
      });
      return;
    }

    // Idempotency: if already onboarded, return existing tenant
    const existingMembership = await adminDb
      .select({
        tenantId: tenantMembershipsTable.tenantId,
        role: tenantMembershipsTable.role,
        slug: tenantsTable.slug,
        name: tenantsTable.name,
        planTier: tenantsTable.planTier,
        status: tenantsTable.status,
        onboardingCompletedAt: tenantsTable.onboardingCompletedAt,
      })
      .from(tenantMembershipsTable)
      .leftJoin(tenantsTable, eq(tenantMembershipsTable.tenantId, tenantsTable.id))
      .where(and(eq(tenantMembershipsTable.clerkId, clerkId), eq(tenantMembershipsTable.isActive, "true")))
      .limit(1);

    if (existingMembership.length > 0) {
      const m = existingMembership[0]!;
      res.json({
        tenantId: m.tenantId,
        slug: m.slug ?? "",
        name: m.name ?? "",
        planTier: m.planTier ?? "starter",
        status: m.status ?? "active",
        role: m.role,
        alreadyOnboarded: true,
        invitesSent: 0,
      });
      return;
    }

    // Resolve Clerk user profile
    let userEmail = "";
    let firstName: string | null = null;
    let lastName: string | null = null;
    try {
      const clerkUser = await clerk.users.getUser(clerkId);
      const primary = clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId) ?? clerkUser.emailAddresses[0];
      userEmail = primary?.emailAddress ?? "";
      firstName = clerkUser.firstName ?? null;
      lastName = clerkUser.lastName ?? null;
    } catch (err) {
      logger.warn({ err, clerkId }, "Failed to fetch Clerk user during onboarding");
    }

    if (!userEmail) {
      res.status(400).json({ error: "Your account has no verified email address.", code: "MISSING_EMAIL" });
      return;
    }

    // ── Transactional core: create tenant + membership + structure ────────────
    const slug = await ensureUniqueSlug(slugify(step1.companyName));
    const now = new Date();

    let tenant: typeof tenantsTable.$inferSelect;
    try {
      tenant = await adminDb.transaction(async (tx) => {
        const [newTenant] = await tx.insert(tenantsTable).values({
          name: step1.companyName,
          tradingName: step1.tradingName ?? null,
          legalName: step1.legalName ?? null,
          taxId: step1.taxId ?? null,
          phone: step1.phone ?? null,
          email: step1.email ?? userEmail,
          website: step1.website ?? null,
          addressLine1: step1.addressLine1 ?? null,
          addressLine2: step1.addressLine2 ?? null,
          city: step1.city ?? null,
          state: step1.state ?? null,
          postalCode: step1.postalCode ?? null,
          country: step1.country ?? null,
          fiscalYearStart: step1.fiscalYearStart ?? 1,
          currency: step1.currency ?? "USD",
          timezone: step1.timezone ?? "UTC",
          industryType: step1.industryType ?? null,
          glTemplate: step2?.glTemplate ?? "standard",
          slug,
          status: "active",
          planTier: step4?.planTier ?? "starter",
          onboardingCompletedAt: now,
        }).returning();

        if (!newTenant) throw new Error("Failed to create tenant");

        await tx.insert(tenantMembershipsTable).values({
          tenantId: newTenant.id,
          clerkId,
          email: userEmail,
          firstName,
          lastName,
          role: "tenant_admin",
          isActive: "true",
        });

        if (step2?.warehouses && step2.warehouses.length > 0) {
          await tx.insert(warehousesTable).values(
            step2.warehouses.map((w, idx) => ({
              tenantId: newTenant.id,
              name: w.name,
              code: w.code ?? null,
              addressLine1: w.addressLine1 ?? null,
              addressLine2: w.addressLine2 ?? null,
              city: w.city ?? null,
              state: w.state ?? null,
              postalCode: w.postalCode ?? null,
              country: w.country ?? null,
              isDefault: (idx === 0 || w.isDefault) ? "true" : "false",
            })),
          );
        }

        if (step2?.departments && step2.departments.length > 0) {
          await tx.insert(departmentsTable).values(
            step2.departments.map((d) => ({
              tenantId: newTenant.id,
              name: d.name,
              code: d.code ?? null,
            })),
          );
        }

        return newTenant;
      });
    } catch (err) {
      logger.error({ err }, "Failed to create tenant during onboarding");
      res.status(500).json({ error: "Failed to set up your workspace. Please try again." });
      return;
    }

    // ── Stripe: create customer + activate subscription ───────────────────────
    const planTierForStripe = step4?.planTier ?? "starter";
    const stripePaymentMethodId = step4?.stripePaymentMethodId;
    let stripeCustomerId: string | null = null;
    let stripeSubscriptionId: string | null = null;

    if (isStripeConfigured() && planTierForStripe !== "starter" && stripePaymentMethodId) {
      const priceLookup: Record<string, string | undefined> = {
        starter: process.env.STRIPE_PRICE_STARTER,
        growth: process.env.STRIPE_PRICE_GROWTH,
        enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
      };
      const priceId = priceLookup[planTierForStripe];
      try {
        const stripe = await getUncachableStripeClient();

        // Create Stripe customer
        const customer = await stripe.customers.create({
          email: userEmail,
          name: step1.companyName,
          metadata: { tenantId: String(tenant.id), clerkUserId: clerkId },
        });
        stripeCustomerId = customer.id;

        // Attach payment method to customer
        await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: stripeCustomerId });
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: { default_payment_method: stripePaymentMethodId },
        });

        // Create subscription — fail hard if price ID is missing
        if (!priceId) {
          throw new Error(`No Stripe price ID configured for plan tier "${planTierForStripe}". Set STRIPE_PRICE_${planTierForStripe.toUpperCase()} env var.`);
        }
        const sub = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{ price: priceId }],
          default_payment_method: stripePaymentMethodId,
          expand: ["latest_invoice.payment_intent"],
        });
        stripeSubscriptionId = sub.id;

        // Persist Stripe IDs
        await adminDb.update(tenantsTable)
          .set({ stripeCustomerId, stripeSubscriptionId })
          .where(eq(tenantsTable.id, tenant.id));

        await writeAuditLog({ req, actorClerkId: clerkId, actorEmail: userEmail, tenantId: tenant.id, action: "tenant.stripe_activated", entityType: "tenant", entityId: tenant.id, newValues: { stripeCustomerId, stripeSubscriptionId, planTier: planTierForStripe } });
      } catch (err) {
        logger.error({ err, tenantId: tenant.id, planTierForStripe }, "Stripe activation failed during onboarding — downgrading to starter plan");
        // Downgrade to starter so an unpaid paid plan is never left active
        await adminDb.update(tenantsTable)
          .set({ planTier: "starter" })
          .where(eq(tenantsTable.id, tenant.id));
        await writeAuditLog({ req, actorClerkId: clerkId, actorEmail: userEmail, tenantId: tenant.id, action: "tenant.stripe_activation_failed", entityType: "tenant", entityId: tenant.id, newValues: { originalPlan: planTierForStripe, downgradedTo: "starter", error: err instanceof Error ? err.message : String(err) } });
      }
    }

    // ── Import items ───────────────────────────────────────────────────────────
    if (step3?.items && step3.items.length > 0) {
      const chunks = [];
      for (let i = 0; i < step3.items.length; i += 100) chunks.push(step3.items.slice(i, i + 100));
      for (const chunk of chunks) {
        await adminDb.insert(itemsTable).values(
          chunk.map((item) => ({
            tenantId: tenant.id,
            code: item.code,
            name: item.name,
            description: item.description ?? null,
            unitOfMeasure: item.unitOfMeasure ?? null,
            unitCost: item.unitCost ? item.unitCost : null,
            category: item.category ?? null,
          })),
        );
      }
    }

    // ── Import suppliers ───────────────────────────────────────────────────────
    if (step3?.suppliers && step3.suppliers.length > 0) {
      const chunks = [];
      for (let i = 0; i < step3.suppliers.length; i += 100) chunks.push(step3.suppliers.slice(i, i + 100));
      for (const chunk of chunks) {
        await adminDb.insert(suppliersTable).values(
          chunk.map((s) => ({
            tenantId: tenant.id,
            code: s.code,
            name: s.name,
            email: s.email || null,
            phone: s.phone || null,
            address: s.address || null,
            contactName: s.contactName || null,
            paymentTerms: s.paymentTerms || null,
            currency: s.currency || "USD",
          })),
        );
      }
    }

    // ── Import customers ───────────────────────────────────────────────────────
    if (step3?.customers && step3.customers.length > 0) {
      const chunks = [];
      for (let i = 0; i < step3.customers.length; i += 100) chunks.push(step3.customers.slice(i, i + 100));
      for (const chunk of chunks) {
        await adminDb.insert(customersTable).values(
          chunk.map((c) => ({
            tenantId: tenant.id,
            code: c.code,
            name: c.name,
            email: c.email || null,
            phone: c.phone || null,
            address: c.address || null,
            contactName: c.contactName || null,
            creditLimit: c.creditLimit || null,
            paymentTerms: c.paymentTerms || null,
            currency: c.currency || "USD",
          })),
        );
      }
    }

    // ── Send invites ───────────────────────────────────────────────────────────
    let invitesSent = 0;
    const inviteResults: Array<{ email: string; role: string; delivered: boolean; reason?: string; clerkInvitationId?: string }> = [];

    if (step5?.invites && step5.invites.length > 0) {
      const seen = new Set<string>([userEmail.toLowerCase()]);
      const inviteRows: Array<typeof tenantMembershipsTable.$inferInsert> = [];

      for (const invite of step5.invites) {
        const lower = invite.email.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        inviteRows.push({ tenantId: tenant.id, clerkId: pendingClerkIdForEmail(lower), email: lower, role: invite.role, isActive: "false" });
      }

      if (inviteRows.length > 0) {
        await adminDb.insert(tenantMembershipsTable).values(inviteRows);
        const redirectUrl = resolveInviteRedirectUrl(req);

        for (const row of inviteRows) {
          try {
            const invitation = await clerk.invitations.createInvitation({
              emailAddress: row.email!,
              redirectUrl,
              publicMetadata: { pendingTenantId: tenant.id, pendingRole: row.role },
              ignoreExisting: true,
              notify: true,
            });
            invitesSent++;
            inviteResults.push({ email: row.email!, role: row.role!, delivered: true, clerkInvitationId: invitation.id });
          } catch (err) {
            const reason = err instanceof Error ? err.message : "Unknown invite error";
            inviteResults.push({ email: row.email!, role: row.role!, delivered: false, reason });
            logger.error({ err, tenantId: tenant.id, inviteEmail: row.email }, "Invite failed");
          }
        }

        await writeAuditLog({ req, actorClerkId: clerkId, actorEmail: userEmail, tenantId: tenant.id, action: "tenant.invites_sent", entityType: "tenant", entityId: tenant.id, newValues: { invites: inviteResults } });
      }
    }

    // ── Audit + Clerk backfill ─────────────────────────────────────────────────
    await writeAuditLog({ req, actorClerkId: clerkId, actorEmail: userEmail, tenantId: tenant.id, action: "tenant.onboarded", entityType: "tenant", entityId: tenant.id, newValues: { name: tenant.name, slug: tenant.slug, planTier: tenant.planTier, invitesSent } });

    // Mark onboarding session complete
    await adminDb
      .update(onboardingSessionsTable)
      .set({ completedAt: now })
      .where(eq(onboardingSessionsTable.clerkUserId, clerkId));

    // Backfill Clerk metadata
    void (async () => {
      try {
        const u = await clerk.users.getUser(clerkId);
        const existing = (u.publicMetadata ?? {}) as Record<string, unknown>;
        await clerk.users.updateUser(clerkId, { publicMetadata: { ...existing, tenantId: tenant.id } });
      } catch (err) {
        logger.warn({ err, clerkId, tenantId: tenant.id }, "Failed to backfill Clerk metadata");
      }
    })();

    // Send welcome email (fire-and-forget — fails gracefully if SMTP not configured)
    void (async () => {
      try {
        const frontendBase = process.env.FRONTEND_URL
          ?? `${req.protocol}://${req.get("x-forwarded-host") ?? req.get("host")}`;
        const loginUrl = `${frontendBase.replace(/\/$/, "")}/forge-erp/dashboard`;
        const emailContent = buildWelcomeEmail({
          firstName,
          companyName: tenant.name,
          planTier: tenant.planTier ?? "starter",
          loginUrl,
        });
        await sendEmail({ to: userEmail, ...emailContent });
      } catch (err) {
        logger.warn({ err, tenantId: tenant.id, userEmail }, "Failed to send welcome email");
      }
    })();

    res.status(201).json({
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      planTier: tenant.planTier,
      status: tenant.status,
      role: "tenant_admin",
      onboardingCompletedAt: tenant.onboardingCompletedAt?.toISOString(),
      invitesSent,
      invitesAttempted: inviteResults.length,
      invites: inviteResults,
      alreadyOnboarded: false,
    });
  },
);

// ── POST /onboarding/create-tenant (backward compat) ──────────────────────────

const createOnboardingTenantSchema = z.object({
  companyName: z.string().min(1).max(200),
  industryType: z.string().max(100).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().max(80).optional(),
  planTier: z.enum(["starter", "growth", "enterprise"]).optional(),
  invites: z.array(z.object({ email: z.string().email(), role: inviteRoleEnum })).max(25).optional(),
});

router.post(
  "/onboarding/create-tenant",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const clerkId = (req as AuthenticatedRequest).clerkUserId;
    const parsed = createOnboardingTenantSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const data = parsed.data;

    const existing = await adminDb.select({ tenantId: tenantMembershipsTable.tenantId, role: tenantMembershipsTable.role, tenantName: tenantsTable.name, slug: tenantsTable.slug, status: tenantsTable.status, planTier: tenantsTable.planTier, onboardingCompletedAt: tenantsTable.onboardingCompletedAt })
      .from(tenantMembershipsTable).leftJoin(tenantsTable, eq(tenantMembershipsTable.tenantId, tenantsTable.id))
      .where(and(eq(tenantMembershipsTable.clerkId, clerkId), eq(tenantMembershipsTable.isActive, "true"))).limit(1);

    if (existing.length > 0) {
      const m = existing[0]!;
      res.status(200).json({ tenantId: m.tenantId, slug: m.slug ?? "", name: m.tenantName ?? "", planTier: m.planTier ?? "starter", status: m.status ?? "trial", role: m.role, onboardingCompletedAt: m.onboardingCompletedAt?.toISOString(), invitesSent: 0, alreadyOnboarded: true });
      return;
    }

    let userEmail = "";
    let firstName: string | null = null;
    let lastName: string | null = null;
    try {
      const clerkUser = await clerk.users.getUser(clerkId);
      const primary = clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId) ?? clerkUser.emailAddresses[0];
      userEmail = primary?.emailAddress ?? "";
      firstName = clerkUser.firstName ?? null;
      lastName = clerkUser.lastName ?? null;
    } catch (err) { logger.warn({ err, clerkId }, "Failed to fetch Clerk user"); }

    if (!userEmail) { res.status(400).json({ error: "No verified email address.", code: "MISSING_EMAIL" }); return; }

    const slug = await ensureUniqueSlug(slugify(data.companyName));
    const now = new Date();
    const [tenant] = await adminDb.insert(tenantsTable).values({ name: data.companyName, slug, status: "trial", planTier: data.planTier ?? "starter", currency: data.currency ?? "USD", timezone: data.timezone ?? "UTC", industryType: data.industryType ?? null, email: userEmail, onboardingCompletedAt: now }).returning();
    if (!tenant) { res.status(500).json({ error: "Failed to create tenant" }); return; }

    await adminDb.insert(tenantMembershipsTable).values({ tenantId: tenant.id, clerkId, email: userEmail, firstName, lastName, role: "tenant_admin", isActive: "true" });

    let invitesSent = 0;
    const inviteResults: Array<{ email: string; role: string; delivered: boolean; reason?: string; clerkInvitationId?: string }> = [];
    if (data.invites && data.invites.length > 0) {
      const seen = new Set<string>([userEmail.toLowerCase()]);
      const inviteRows: Array<typeof tenantMembershipsTable.$inferInsert> = [];
      for (const invite of data.invites) {
        const lower = invite.email.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        inviteRows.push({ tenantId: tenant.id, clerkId: pendingClerkIdForEmail(lower), email: lower, role: invite.role, isActive: "false" });
      }
      if (inviteRows.length > 0) {
        await adminDb.insert(tenantMembershipsTable).values(inviteRows);
        const redirectUrl = resolveInviteRedirectUrl(req);
        for (const row of inviteRows) {
          try {
            const invitation = await clerk.invitations.createInvitation({ emailAddress: row.email!, redirectUrl, publicMetadata: { pendingTenantId: tenant.id, pendingRole: row.role }, ignoreExisting: true, notify: true });
            invitesSent++;
            inviteResults.push({ email: row.email!, role: row.role!, delivered: true, clerkInvitationId: invitation.id });
          } catch (err) {
            const reason = err instanceof Error ? err.message : "Unknown invite error";
            inviteResults.push({ email: row.email!, role: row.role!, delivered: false, reason });
          }
        }
        await writeAuditLog({ req, actorClerkId: clerkId, actorEmail: userEmail, tenantId: tenant.id, action: "tenant.invites_sent", entityType: "tenant", entityId: tenant.id, newValues: { invites: inviteResults } });
      }
    }

    await writeAuditLog({ req, actorClerkId: clerkId, actorEmail: userEmail, tenantId: tenant.id, action: "tenant.onboarded", entityType: "tenant", entityId: tenant.id, newValues: { name: tenant.name, slug: tenant.slug, planTier: tenant.planTier, invitesSent } });
    void (async () => {
      try {
        const u = await clerk.users.getUser(clerkId);
        const existing = (u.publicMetadata ?? {}) as Record<string, unknown>;
        await clerk.users.updateUser(clerkId, { publicMetadata: { ...existing, tenantId: tenant.id } });
      } catch (err) { logger.warn({ err, clerkId, tenantId: tenant.id }, "Failed to backfill Clerk metadata"); }
    })();

    res.status(201).json({ tenantId: tenant.id, slug: tenant.slug, name: tenant.name, planTier: tenant.planTier, status: tenant.status, role: "tenant_admin", onboardingCompletedAt: tenant.onboardingCompletedAt?.toISOString(), invitesSent, invitesAttempted: inviteResults.length, invites: inviteResults, alreadyOnboarded: false });
  },
);

export default router;
