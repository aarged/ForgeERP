import { Router, type IRouter } from "express";
import { eq, and, ilike, or, isNull, desc, asc, sql, count } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import {
  itemsTable,
  itemVariantsTable,
  itemAttributesTable,
  itemLocationsTable,
  itemCrossReferencesTable,
  suppliersTable,
  supplierContactsTable,
  customersTable,
  customerContactsTable,
  warehousesTable,
  warehouseLocationsTable,
  glAccountsTable,
  auditLogsTable,
  adminPool,
} from "@workspace/db";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { withTenantDb } from "@workspace/db/rls";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import type { Request, Response } from "express";
import { z } from "zod";

const adminDb = drizzlePg(adminPool, { schema });

const router: IRouter = Router();

const tenantUserMiddleware = [
  requireAuth,
  tenantContext,
  requireRole(
    "viewer",
    "purchaser",
    "warehouse",
    "approver",
    "accountant",
    "tenant_admin",
    "super_admin",
  ),
];

const tenantWriteMiddleware = [
  requireAuth,
  tenantContext,
  requireRole(
    "purchaser",
    "warehouse",
    "approver",
    "accountant",
    "tenant_admin",
    "super_admin",
  ),
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const offset = (page - 1) * limit;
  const sortField = String(query.sort || "createdAt");
  const sortDir = String(query.dir || "desc") === "asc" ? "asc" : "desc";
  return { page, limit, offset, sortField, sortDir };
}

function parseSearch(query: Record<string, unknown>): string | undefined {
  return query.q ? String(query.q).trim() : undefined;
}

// ════════════════════════════════════════════════════════════════════════════
//  ITEMS
// ════════════════════════════════════════════════════════════════════════════

router.get(
  "/master-data/items",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const { limit, offset, sortField, sortDir } = parsePagination(req.query);
    const search = parseSearch(req.query);
    const category = req.query.category ? String(req.query.category) : undefined;
    const itemType = req.query.itemType ? String(req.query.itemType) : undefined;
    const activeOnly = req.query.activeOnly !== "false";

    const itemsSortCols: Record<string, AnyColumn> = {
      code: itemsTable.code,
      name: itemsTable.name,
      category: itemsTable.category,
      unitCost: itemsTable.unitCost,
      salesPrice: itemsTable.salesPrice,
      createdAt: itemsTable.createdAt,
    };
    const sortCol = itemsSortCols[sortField] ?? itemsTable.name;

    const rows = await withTenantDb(tenantId, (db) => {
      let q = db
        .select()
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.tenantId, tenantId),
            isNull(itemsTable.deletedAt),
            activeOnly ? eq(itemsTable.isActive, true) : undefined,
            search
              ? or(
                  ilike(itemsTable.code, `%${search}%`),
                  ilike(itemsTable.name, `%${search}%`),
                  ilike(itemsTable.description, `%${search}%`),
                  ilike(itemsTable.barcode, `%${search}%`),
                )
              : undefined,
            category ? eq(itemsTable.category, category) : undefined,
            itemType ? eq(itemsTable.itemType, itemType) : undefined,
          ),
        )
        .limit(limit + 1)
        .offset(offset);

      return sortDir === "asc"
        ? q.orderBy(asc(sortCol))
        : q.orderBy(desc(sortCol));
    });

    const hasMore = rows.length > limit;
    res.json({ items: rows.slice(0, limit), hasMore });
  },
);

router.get(
  "/master-data/items/:id",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [item, variants, attributes, locations, crossRefs] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select().from(itemsTable)
          .where(and(eq(itemsTable.id, id), eq(itemsTable.tenantId, tenantId), isNull(itemsTable.deletedAt)))
          .limit(1),
      ),
      withTenantDb(tenantId, (db) =>
        db.select().from(itemVariantsTable)
          .where(and(eq(itemVariantsTable.itemId, id), eq(itemVariantsTable.tenantId, tenantId)))
          .orderBy(asc(itemVariantsTable.variantCode)),
      ),
      withTenantDb(tenantId, (db) =>
        db.select().from(itemAttributesTable)
          .where(and(eq(itemAttributesTable.itemId, id), eq(itemAttributesTable.tenantId, tenantId))),
      ),
      withTenantDb(tenantId, (db) =>
        db.select().from(itemLocationsTable)
          .where(and(eq(itemLocationsTable.itemId, id), eq(itemLocationsTable.tenantId, tenantId))),
      ),
      withTenantDb(tenantId, (db) =>
        db.select().from(itemCrossReferencesTable)
          .where(and(eq(itemCrossReferencesTable.itemId, id), eq(itemCrossReferencesTable.tenantId, tenantId))),
      ),
    ]);

    if (!item[0]) { res.status(404).json({ error: "Item not found" }); return; }
    res.json({ ...item[0], variants, attributes, locations, crossRefs });
  },
);

const itemCreateSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  itemType: z.enum(["stock", "service", "charge"]).default("stock"),
  trackingType: z.enum(["none", "lot", "serial", "batch"]).default("none"),
  unitOfMeasure: z.string().optional(),
  packSize: z.coerce.number().optional(),
  barcode: z.string().optional(),
  unitCost: z.coerce.number().optional(),
  salesPrice: z.coerce.number().optional(),
  category: z.string().optional(),
  imageUrl: z.string().optional(),
  isActive: z.boolean().default(true),
  hasVariants: z.boolean().default(false),
  notes: z.string().optional(),
});

router.post(
  "/master-data/items",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const parsed = itemCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [item] = await withTenantDb(tenantId, (db) =>
      db.insert(itemsTable).values({ ...parsed.data, tenantId } as typeof itemsTable.$inferInsert).returning(),
    );

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "item.created", entityType: "item", entityId: item!.id, newValues: parsed.data });
    res.status(201).json(item);
  },
);

router.patch(
  "/master-data/items/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = itemCreateSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [item] = await withTenantDb(tenantId, (db) =>
      db.update(itemsTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(itemsTable.id, id), eq(itemsTable.tenantId, tenantId), isNull(itemsTable.deletedAt)))
        .returning(),
    );

    if (!item) { res.status(404).json({ error: "Item not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "item.updated", entityType: "item", entityId: id, newValues: parsed.data });
    res.json(item);
  },
);

router.delete(
  "/master-data/items/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [item] = await withTenantDb(tenantId, (db) =>
      db.update(itemsTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(itemsTable.id, id), eq(itemsTable.tenantId, tenantId), isNull(itemsTable.deletedAt)))
        .returning(),
    );

    if (!item) { res.status(404).json({ error: "Item not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "item.deleted", entityType: "item", entityId: id });
    res.status(204).send();
  },
);

// Item variants
router.post(
  "/master-data/items/:id/variants",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const itemId = Number(req.params.id);
    if (!itemId) { res.status(400).json({ error: "Invalid ID" }); return; }

    const schema = z.object({
      variantCode: z.string().min(1),
      name: z.string().min(1),
      sku: z.string().optional(),
      barcode: z.string().optional(),
      attributes: z.record(z.string()).optional(),
      costAdjustment: z.coerce.number().optional(),
      priceAdjustment: z.coerce.number().optional(),
      isActive: z.boolean().default(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [variant] = await withTenantDb(tenantId, (db) =>
      db.insert(itemVariantsTable).values({ ...parsed.data, itemId, tenantId } as typeof itemVariantsTable.$inferInsert).returning(),
    );

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "item_variant.created", entityType: "item_variant", entityId: variant!.id, newValues: { itemId, ...parsed.data } });
    res.status(201).json(variant);
  },
);

router.delete(
  "/master-data/items/:itemId/variants/:variantId",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const itemId = Number(req.params.itemId);
    const variantId = Number(req.params.variantId);

    await withTenantDb(tenantId, (db) =>
      db.delete(itemVariantsTable)
        .where(and(eq(itemVariantsTable.id, variantId), eq(itemVariantsTable.itemId, itemId), eq(itemVariantsTable.tenantId, tenantId))),
    );
    res.status(204).send();
  },
);

// Item attributes
router.put(
  "/master-data/items/:id/attributes",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const itemId = Number(req.params.id);
    if (!itemId) { res.status(400).json({ error: "Invalid ID" }); return; }

    const schema = z.array(z.object({ attrKey: z.string().min(1), attrValue: z.string().optional() }));
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    await withTenantDb(tenantId, async (db) => {
      await db.delete(itemAttributesTable).where(and(eq(itemAttributesTable.itemId, itemId), eq(itemAttributesTable.tenantId, tenantId)));
      if (parsed.data.length > 0) {
        await db.insert(itemAttributesTable).values(parsed.data.map((a) => ({ ...a, itemId, tenantId })));
      }
    });

    const attrs = await withTenantDb(tenantId, (db) =>
      db.select().from(itemAttributesTable).where(and(eq(itemAttributesTable.itemId, itemId), eq(itemAttributesTable.tenantId, tenantId))),
    );
    res.json(attrs);
  },
);

// Item cross references
router.put(
  "/master-data/items/:id/cross-references",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const itemId = Number(req.params.id);
    if (!itemId) { res.status(400).json({ error: "Invalid ID" }); return; }

    const schema = z.array(z.object({
      refType: z.enum(["alternative", "cross", "competitor"]).default("alternative"),
      refCode: z.string().min(1),
      refDescription: z.string().optional(),
      supplierId: z.number().optional(),
    }));
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    await withTenantDb(tenantId, async (db) => {
      await db.delete(itemCrossReferencesTable).where(and(eq(itemCrossReferencesTable.itemId, itemId), eq(itemCrossReferencesTable.tenantId, tenantId)));
      if (parsed.data.length > 0) {
        await db.insert(itemCrossReferencesTable).values(parsed.data.map((r) => ({ ...r, itemId, tenantId })));
      }
    });

    const refs = await withTenantDb(tenantId, (db) =>
      db.select().from(itemCrossReferencesTable).where(and(eq(itemCrossReferencesTable.itemId, itemId), eq(itemCrossReferencesTable.tenantId, tenantId))),
    );
    res.json(refs);
  },
);

// Item CSV bulk import
router.post(
  "/master-data/items/import",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;

    const schema = z.object({
      items: z.array(z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        unitOfMeasure: z.string().optional(),
        unitCost: z.coerce.number().optional(),
        salesPrice: z.coerce.number().optional(),
        category: z.string().optional(),
        itemType: z.enum(["stock", "service", "charge"]).default("stock"),
        barcode: z.string().optional(),
      })).min(1).max(5000),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const { items } = parsed.data;
    let created = 0;
    let updated = 0;
    const errors: { row: number; code: string; error: string }[] = [];

    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      for (const item of chunk) {
        try {
          const existing = await withTenantDb(tenantId, (db) =>
            db.select({ id: itemsTable.id }).from(itemsTable)
              .where(and(eq(itemsTable.code, item.code), eq(itemsTable.tenantId, tenantId), isNull(itemsTable.deletedAt)))
              .limit(1),
          );
          if (existing.length > 0) {
            await withTenantDb(tenantId, (db) =>
              db.update(itemsTable).set(item as Record<string, unknown>)
                .where(and(eq(itemsTable.id, existing[0]!.id), eq(itemsTable.tenantId, tenantId))),
            );
            updated++;
          } else {
            await withTenantDb(tenantId, (db) =>
              db.insert(itemsTable).values({ ...item, tenantId } as typeof itemsTable.$inferInsert),
            );
            created++;
          }
        } catch (err) {
          errors.push({ row: i + chunk.indexOf(item) + 1, code: item.code, error: err instanceof Error ? err.message : "Unknown error" });
        }
      }
    }

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "item.bulk_import", entityType: "item", entityId: tenantId, newValues: { created, updated, errorCount: errors.length } });
    res.json({ created, updated, errors });
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  SUPPLIERS
// ════════════════════════════════════════════════════════════════════════════

router.get(
  "/master-data/suppliers",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const { limit, offset, sortDir } = parsePagination(req.query);
    const search = parseSearch(req.query);
    const activeOnly = req.query.activeOnly !== "false";

    const rows = await withTenantDb(tenantId, (db) => {
      let q = db.select().from(suppliersTable).where(
        and(
          eq(suppliersTable.tenantId, tenantId),
          isNull(suppliersTable.deletedAt),
          activeOnly ? eq(suppliersTable.isActive, true) : undefined,
          search
            ? or(
                ilike(suppliersTable.code, `%${search}%`),
                ilike(suppliersTable.name, `%${search}%`),
                ilike(suppliersTable.email, `%${search}%`),
              )
            : undefined,
        ),
      ).limit(limit + 1).offset(offset);

      return sortDir === "asc"
        ? q.orderBy(asc(suppliersTable.name))
        : q.orderBy(desc(suppliersTable.name));
    });

    const hasMore = rows.length > limit;
    res.json({ suppliers: rows.slice(0, limit), hasMore });
  },
);

router.get(
  "/master-data/suppliers/:id",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [supplier, contacts] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select().from(suppliersTable)
          .where(and(eq(suppliersTable.id, id), eq(suppliersTable.tenantId, tenantId), isNull(suppliersTable.deletedAt)))
          .limit(1),
      ),
      withTenantDb(tenantId, (db) =>
        db.select().from(supplierContactsTable)
          .where(and(eq(supplierContactsTable.supplierId, id), eq(supplierContactsTable.tenantId, tenantId)))
          .orderBy(desc(supplierContactsTable.isPrimary)),
      ),
    ]);

    if (!supplier[0]) { res.status(404).json({ error: "Supplier not found" }); return; }
    res.json({ ...supplier[0], contacts });
  },
);

const supplierSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  legalName: z.string().optional(),
  taxId: z.string().optional(),
  abn: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  website: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  deliveryAddressLine1: z.string().optional(),
  deliveryCity: z.string().optional(),
  deliveryState: z.string().optional(),
  deliveryPostalCode: z.string().optional(),
  deliveryCountry: z.string().optional(),
  paymentTerms: z.string().optional(),
  currency: z.string().default("USD"),
  pricingTier: z.string().optional(),
  creditLimit: z.coerce.number().optional(),
  isActive: z.boolean().default(true),
  notes: z.string().optional(),
});

router.post(
  "/master-data/suppliers",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const parsed = supplierSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [supplier] = await withTenantDb(tenantId, (db) =>
      db.insert(suppliersTable).values({ ...parsed.data, tenantId } as typeof suppliersTable.$inferInsert).returning(),
    );

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "supplier.created", entityType: "supplier", entityId: supplier!.id, newValues: parsed.data });
    res.status(201).json(supplier);
  },
);

router.patch(
  "/master-data/suppliers/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = supplierSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [supplier] = await withTenantDb(tenantId, (db) =>
      db.update(suppliersTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(suppliersTable.id, id), eq(suppliersTable.tenantId, tenantId), isNull(suppliersTable.deletedAt)))
        .returning(),
    );

    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "supplier.updated", entityType: "supplier", entityId: id, newValues: parsed.data });
    res.json(supplier);
  },
);

router.delete(
  "/master-data/suppliers/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [supplier] = await withTenantDb(tenantId, (db) =>
      db.update(suppliersTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(suppliersTable.id, id), eq(suppliersTable.tenantId, tenantId), isNull(suppliersTable.deletedAt)))
        .returning(),
    );

    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "supplier.deleted", entityType: "supplier", entityId: id });
    res.status(204).send();
  },
);

// Supplier contacts
const contactSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  role: z.string().optional(),
  isPrimary: z.boolean().default(false),
});

router.post(
  "/master-data/suppliers/:id/contacts",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const supplierId = Number(req.params.id);
    if (!supplierId) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [contact] = await withTenantDb(tenantId, (db) =>
      db.insert(supplierContactsTable).values({ ...parsed.data, supplierId, tenantId } as typeof supplierContactsTable.$inferInsert).returning(),
    );
    res.status(201).json(contact);
  },
);

router.patch(
  "/master-data/suppliers/:supplierId/contacts/:contactId",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const supplierId = Number(req.params.supplierId);
    const contactId = Number(req.params.contactId);

    const parsed = contactSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [contact] = await withTenantDb(tenantId, (db) =>
      db.update(supplierContactsTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(supplierContactsTable.id, contactId), eq(supplierContactsTable.supplierId, supplierId), eq(supplierContactsTable.tenantId, tenantId)))
        .returning(),
    );

    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    res.json(contact);
  },
);

router.delete(
  "/master-data/suppliers/:supplierId/contacts/:contactId",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const supplierId = Number(req.params.supplierId);
    const contactId = Number(req.params.contactId);

    await withTenantDb(tenantId, (db) =>
      db.delete(supplierContactsTable)
        .where(and(eq(supplierContactsTable.id, contactId), eq(supplierContactsTable.supplierId, supplierId), eq(supplierContactsTable.tenantId, tenantId))),
    );
    res.status(204).send();
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ════════════════════════════════════════════════════════════════════════════

router.get(
  "/master-data/customers",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const { limit, offset, sortDir } = parsePagination(req.query);
    const search = parseSearch(req.query);
    const activeOnly = req.query.activeOnly !== "false";

    const rows = await withTenantDb(tenantId, (db) => {
      let q = db.select().from(customersTable).where(
        and(
          eq(customersTable.tenantId, tenantId),
          isNull(customersTable.deletedAt),
          activeOnly ? eq(customersTable.isActive, true) : undefined,
          search
            ? or(
                ilike(customersTable.code, `%${search}%`),
                ilike(customersTable.name, `%${search}%`),
                ilike(customersTable.email, `%${search}%`),
              )
            : undefined,
        ),
      ).limit(limit + 1).offset(offset);

      return sortDir === "asc"
        ? q.orderBy(asc(customersTable.name))
        : q.orderBy(desc(customersTable.name));
    });

    const hasMore = rows.length > limit;
    res.json({ customers: rows.slice(0, limit), hasMore });
  },
);

router.get(
  "/master-data/customers/:id",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [customer, contacts] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select().from(customersTable)
          .where(and(eq(customersTable.id, id), eq(customersTable.tenantId, tenantId), isNull(customersTable.deletedAt)))
          .limit(1),
      ),
      withTenantDb(tenantId, (db) =>
        db.select().from(customerContactsTable)
          .where(and(eq(customerContactsTable.customerId, id), eq(customerContactsTable.tenantId, tenantId)))
          .orderBy(desc(customerContactsTable.isPrimary)),
      ),
    ]);

    if (!customer[0]) { res.status(404).json({ error: "Customer not found" }); return; }
    res.json({ ...customer[0], contacts });
  },
);

const customerSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  legalName: z.string().optional(),
  taxId: z.string().optional(),
  abn: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  website: z.string().optional(),
  billingAddressLine1: z.string().optional(),
  billingAddressLine2: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingPostalCode: z.string().optional(),
  billingCountry: z.string().optional(),
  shippingAddressLine1: z.string().optional(),
  shippingAddressLine2: z.string().optional(),
  shippingCity: z.string().optional(),
  shippingState: z.string().optional(),
  shippingPostalCode: z.string().optional(),
  shippingCountry: z.string().optional(),
  creditLimit: z.coerce.number().optional(),
  paymentTerms: z.string().optional(),
  currency: z.string().default("USD"),
  pricingTier: z.string().optional(),
  isActive: z.boolean().default(true),
  notes: z.string().optional(),
});

router.post(
  "/master-data/customers",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [customer] = await withTenantDb(tenantId, (db) =>
      db.insert(customersTable).values({ ...parsed.data, tenantId } as typeof customersTable.$inferInsert).returning(),
    );

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "customer.created", entityType: "customer", entityId: customer!.id, newValues: parsed.data });
    res.status(201).json(customer);
  },
);

router.patch(
  "/master-data/customers/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = customerSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [customer] = await withTenantDb(tenantId, (db) =>
      db.update(customersTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(customersTable.id, id), eq(customersTable.tenantId, tenantId), isNull(customersTable.deletedAt)))
        .returning(),
    );

    if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "customer.updated", entityType: "customer", entityId: id, newValues: parsed.data });
    res.json(customer);
  },
);

router.delete(
  "/master-data/customers/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [customer] = await withTenantDb(tenantId, (db) =>
      db.update(customersTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(customersTable.id, id), eq(customersTable.tenantId, tenantId), isNull(customersTable.deletedAt)))
        .returning(),
    );

    if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "customer.deleted", entityType: "customer", entityId: id });
    res.status(204).send();
  },
);

// Customer contacts
router.post(
  "/master-data/customers/:id/contacts",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const customerId = Number(req.params.id);
    if (!customerId) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [contact] = await withTenantDb(tenantId, (db) =>
      db.insert(customerContactsTable).values({ ...parsed.data, customerId, tenantId } as typeof customerContactsTable.$inferInsert).returning(),
    );
    res.status(201).json(contact);
  },
);

router.patch(
  "/master-data/customers/:customerId/contacts/:contactId",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const customerId = Number(req.params.customerId);
    const contactId = Number(req.params.contactId);

    const parsed = contactSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [contact] = await withTenantDb(tenantId, (db) =>
      db.update(customerContactsTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(customerContactsTable.id, contactId), eq(customerContactsTable.customerId, customerId), eq(customerContactsTable.tenantId, tenantId)))
        .returning(),
    );

    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    res.json(contact);
  },
);

router.delete(
  "/master-data/customers/:customerId/contacts/:contactId",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const customerId = Number(req.params.customerId);
    const contactId = Number(req.params.contactId);

    await withTenantDb(tenantId, (db) =>
      db.delete(customerContactsTable)
        .where(and(eq(customerContactsTable.id, contactId), eq(customerContactsTable.customerId, customerId), eq(customerContactsTable.tenantId, tenantId))),
    );
    res.status(204).send();
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  WAREHOUSES
// ════════════════════════════════════════════════════════════════════════════

router.get(
  "/master-data/warehouses",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const { limit, offset } = parsePagination(req.query);
    const search = parseSearch(req.query);
    const activeOnly = req.query.activeOnly !== "false";

    const rows = await withTenantDb(tenantId, (db) =>
      db.select().from(warehousesTable).where(
        and(
          eq(warehousesTable.tenantId, tenantId),
          isNull(warehousesTable.deletedAt),
          activeOnly ? eq(warehousesTable.isActive, true) : undefined,
          search ? or(ilike(warehousesTable.name, `%${search}%`), ilike(warehousesTable.code, `%${search}%`)) : undefined,
        ),
      ).orderBy(asc(warehousesTable.name)).limit(limit + 1).offset(offset),
    );

    const hasMore = rows.length > limit;
    res.json({ warehouses: rows.slice(0, limit), hasMore });
  },
);

router.get(
  "/master-data/warehouses/:id",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [warehouse, locations] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select().from(warehousesTable)
          .where(and(eq(warehousesTable.id, id), eq(warehousesTable.tenantId, tenantId), isNull(warehousesTable.deletedAt)))
          .limit(1),
      ),
      withTenantDb(tenantId, (db) =>
        db.select().from(warehouseLocationsTable)
          .where(and(eq(warehouseLocationsTable.warehouseId, id), eq(warehouseLocationsTable.tenantId, tenantId)))
          .orderBy(asc(warehouseLocationsTable.code)),
      ),
    ]);

    if (!warehouse[0]) { res.status(404).json({ error: "Warehouse not found" }); return; }
    res.json({ ...warehouse[0], locations });
  },
);

const warehouseSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  isDefault: z.enum(["true", "false"]).default("false"),
  isActive: z.boolean().default(true),
  notes: z.string().optional(),
});

router.post(
  "/master-data/warehouses",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const parsed = warehouseSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [warehouse] = await withTenantDb(tenantId, (db) =>
      db.insert(warehousesTable).values({ ...parsed.data, tenantId } as typeof warehousesTable.$inferInsert).returning(),
    );

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "warehouse.created", entityType: "warehouse", entityId: warehouse!.id, newValues: parsed.data });
    res.status(201).json(warehouse);
  },
);

router.patch(
  "/master-data/warehouses/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = warehouseSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [warehouse] = await withTenantDb(tenantId, (db) =>
      db.update(warehousesTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(warehousesTable.id, id), eq(warehousesTable.tenantId, tenantId), isNull(warehousesTable.deletedAt)))
        .returning(),
    );

    if (!warehouse) { res.status(404).json({ error: "Warehouse not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "warehouse.updated", entityType: "warehouse", entityId: id, newValues: parsed.data });
    res.json(warehouse);
  },
);

router.delete(
  "/master-data/warehouses/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [warehouse] = await withTenantDb(tenantId, (db) =>
      db.update(warehousesTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(warehousesTable.id, id), eq(warehousesTable.tenantId, tenantId), isNull(warehousesTable.deletedAt)))
        .returning(),
    );

    if (!warehouse) { res.status(404).json({ error: "Warehouse not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "warehouse.deleted", entityType: "warehouse", entityId: id });
    res.status(204).send();
  },
);

// Warehouse locations (zones → aisles → bins)
const locationSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  locationType: z.enum(["zone", "aisle", "bin"]).default("bin"),
  parentId: z.number().optional(),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});

router.post(
  "/master-data/warehouses/:id/locations",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const warehouseId = Number(req.params.id);
    if (!warehouseId) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = locationSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [location] = await withTenantDb(tenantId, (db) =>
      db.insert(warehouseLocationsTable).values({ ...parsed.data, warehouseId, tenantId } as typeof warehouseLocationsTable.$inferInsert).returning(),
    );
    res.status(201).json(location);
  },
);

router.patch(
  "/master-data/warehouses/:warehouseId/locations/:locationId",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const warehouseId = Number(req.params.warehouseId);
    const locationId = Number(req.params.locationId);

    const parsed = locationSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [location] = await withTenantDb(tenantId, (db) =>
      db.update(warehouseLocationsTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(warehouseLocationsTable.id, locationId), eq(warehouseLocationsTable.warehouseId, warehouseId), eq(warehouseLocationsTable.tenantId, tenantId)))
        .returning(),
    );

    if (!location) { res.status(404).json({ error: "Location not found" }); return; }
    res.json(location);
  },
);

router.delete(
  "/master-data/warehouses/:warehouseId/locations/:locationId",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const warehouseId = Number(req.params.warehouseId);
    const locationId = Number(req.params.locationId);

    await withTenantDb(tenantId, (db) =>
      db.delete(warehouseLocationsTable)
        .where(and(eq(warehouseLocationsTable.id, locationId), eq(warehouseLocationsTable.warehouseId, warehouseId), eq(warehouseLocationsTable.tenantId, tenantId))),
    );
    res.status(204).send();
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  GL CHART OF ACCOUNTS
// ════════════════════════════════════════════════════════════════════════════

router.get(
  "/master-data/gl-accounts",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const { limit, offset, sortDir } = parsePagination(req.query);
    const search = parseSearch(req.query);
    const accountType = req.query.accountType ? String(req.query.accountType) : undefined;
    const activeOnly = req.query.activeOnly !== "false";

    const rows = await withTenantDb(tenantId, (db) => {
      let q = db.select().from(glAccountsTable).where(
        and(
          eq(glAccountsTable.tenantId, tenantId),
          isNull(glAccountsTable.deletedAt),
          activeOnly ? eq(glAccountsTable.isActive, true) : undefined,
          accountType ? eq(glAccountsTable.accountType, accountType) : undefined,
          search
            ? or(
                ilike(glAccountsTable.code, `%${search}%`),
                ilike(glAccountsTable.name, `%${search}%`),
              )
            : undefined,
        ),
      ).limit(limit + 1).offset(offset);

      return sortDir === "asc"
        ? q.orderBy(asc(glAccountsTable.code))
        : q.orderBy(desc(glAccountsTable.code));
    });

    const hasMore = rows.length > limit;
    res.json({ accounts: rows.slice(0, limit), hasMore });
  },
);

router.get(
  "/master-data/gl-accounts/:id",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const account = await withTenantDb(tenantId, (db) =>
      db.select().from(glAccountsTable)
        .where(and(eq(glAccountsTable.id, id), eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt)))
        .limit(1),
    );

    if (!account[0]) { res.status(404).json({ error: "GL account not found" }); return; }
    res.json(account[0]);
  },
);

const glAccountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  description: z.string().optional(),
  taxCode: z.string().optional(),
  parentId: z.number().optional(),
  isPosting: z.boolean().default(true),
  isActive: z.boolean().default(true),
  glTemplate: z.string().optional(),
});

router.post(
  "/master-data/gl-accounts",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const parsed = glAccountSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [account] = await withTenantDb(tenantId, (db) =>
      db.insert(glAccountsTable).values({ ...parsed.data, tenantId } as typeof glAccountsTable.$inferInsert).returning(),
    );

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "gl_account.created", entityType: "gl_account", entityId: account!.id, newValues: parsed.data });
    res.status(201).json(account);
  },
);

router.patch(
  "/master-data/gl-accounts/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = glAccountSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const [account] = await withTenantDb(tenantId, (db) =>
      db.update(glAccountsTable)
        .set(parsed.data as Record<string, unknown>)
        .where(and(eq(glAccountsTable.id, id), eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt)))
        .returning(),
    );

    if (!account) { res.status(404).json({ error: "GL account not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "gl_account.updated", entityType: "gl_account", entityId: id, newValues: parsed.data });
    res.json(account);
  },
);

router.delete(
  "/master-data/gl-accounts/:id",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [account] = await withTenantDb(tenantId, (db) =>
      db.update(glAccountsTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(glAccountsTable.id, id), eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt)))
        .returning(),
    );

    if (!account) { res.status(404).json({ error: "GL account not found" }); return; }
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "gl_account.deleted", entityType: "gl_account", entityId: id });
    res.status(204).send();
  },
);

// GL account template import
const GL_TEMPLATES: Record<string, Array<{ code: string; name: string; accountType: string; isPosting: boolean; parentCode?: string }>> = {
  standard: [
    { code: "1000", name: "Assets", accountType: "asset", isPosting: false },
    { code: "1100", name: "Current Assets", accountType: "asset", isPosting: false, parentCode: "1000" },
    { code: "1110", name: "Cash & Bank", accountType: "asset", isPosting: true, parentCode: "1100" },
    { code: "1120", name: "Accounts Receivable", accountType: "asset", isPosting: true, parentCode: "1100" },
    { code: "1130", name: "Inventory", accountType: "asset", isPosting: true, parentCode: "1100" },
    { code: "1140", name: "Prepaid Expenses", accountType: "asset", isPosting: true, parentCode: "1100" },
    { code: "1200", name: "Fixed Assets", accountType: "asset", isPosting: false, parentCode: "1000" },
    { code: "1210", name: "Property, Plant & Equipment", accountType: "asset", isPosting: true, parentCode: "1200" },
    { code: "1220", name: "Accumulated Depreciation", accountType: "asset", isPosting: true, parentCode: "1200" },
    { code: "2000", name: "Liabilities", accountType: "liability", isPosting: false },
    { code: "2100", name: "Current Liabilities", accountType: "liability", isPosting: false, parentCode: "2000" },
    { code: "2110", name: "Accounts Payable", accountType: "liability", isPosting: true, parentCode: "2100" },
    { code: "2120", name: "Accrued Expenses", accountType: "liability", isPosting: true, parentCode: "2100" },
    { code: "2130", name: "GST/VAT Payable", accountType: "liability", isPosting: true, parentCode: "2100" },
    { code: "2200", name: "Long-term Liabilities", accountType: "liability", isPosting: false, parentCode: "2000" },
    { code: "2210", name: "Bank Loans", accountType: "liability", isPosting: true, parentCode: "2200" },
    { code: "3000", name: "Equity", accountType: "equity", isPosting: false },
    { code: "3100", name: "Share Capital", accountType: "equity", isPosting: true, parentCode: "3000" },
    { code: "3200", name: "Retained Earnings", accountType: "equity", isPosting: true, parentCode: "3000" },
    { code: "4000", name: "Revenue", accountType: "revenue", isPosting: false },
    { code: "4100", name: "Sales Revenue", accountType: "revenue", isPosting: true, parentCode: "4000" },
    { code: "4200", name: "Service Revenue", accountType: "revenue", isPosting: true, parentCode: "4000" },
    { code: "4300", name: "Other Income", accountType: "revenue", isPosting: true, parentCode: "4000" },
    { code: "5000", name: "Expenses", accountType: "expense", isPosting: false },
    { code: "5100", name: "Cost of Goods Sold", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5200", name: "Payroll Expense", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5300", name: "Rent & Utilities", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5400", name: "Marketing & Advertising", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5500", name: "General & Administrative", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5600", name: "Depreciation Expense", accountType: "expense", isPosting: true, parentCode: "5000" },
  ],
  manufacturing: [
    { code: "1000", name: "Assets", accountType: "asset", isPosting: false },
    { code: "1110", name: "Cash & Bank", accountType: "asset", isPosting: true, parentCode: "1000" },
    { code: "1120", name: "Accounts Receivable", accountType: "asset", isPosting: true, parentCode: "1000" },
    { code: "1130", name: "Raw Materials Inventory", accountType: "asset", isPosting: true, parentCode: "1000" },
    { code: "1131", name: "Work in Progress", accountType: "asset", isPosting: true, parentCode: "1000" },
    { code: "1132", name: "Finished Goods Inventory", accountType: "asset", isPosting: true, parentCode: "1000" },
    { code: "2000", name: "Liabilities", accountType: "liability", isPosting: false },
    { code: "2110", name: "Accounts Payable", accountType: "liability", isPosting: true, parentCode: "2000" },
    { code: "3000", name: "Equity", accountType: "equity", isPosting: false },
    { code: "3100", name: "Share Capital", accountType: "equity", isPosting: true, parentCode: "3000" },
    { code: "4000", name: "Revenue", accountType: "revenue", isPosting: false },
    { code: "4100", name: "Product Sales", accountType: "revenue", isPosting: true, parentCode: "4000" },
    { code: "5000", name: "Cost of Production", accountType: "expense", isPosting: false },
    { code: "5100", name: "Direct Materials", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5200", name: "Direct Labour", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5300", name: "Manufacturing Overhead", accountType: "expense", isPosting: true, parentCode: "5000" },
    { code: "5400", name: "Selling & Distribution", accountType: "expense", isPosting: true, parentCode: "5000" },
  ],
};

router.post(
  "/master-data/gl-accounts/import-template",
  ...tenantWriteMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const schema = z.object({ template: z.enum(["standard", "manufacturing"]).default("standard"), clearExisting: z.boolean().default(false) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

    const { template, clearExisting } = parsed.data;
    const accounts = GL_TEMPLATES[template] ?? GL_TEMPLATES["standard"]!;

    if (clearExisting) {
      await withTenantDb(tenantId, (db) =>
        db.update(glAccountsTable)
          .set({ deletedAt: new Date() })
          .where(and(eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt))),
      );
    }

    // Insert in order so parent accounts exist before children
    const codeToId: Record<string, number> = {};
    for (const acct of accounts) {
      const [inserted] = await withTenantDb(tenantId, (db) =>
        db.insert(glAccountsTable).values({
          tenantId,
          code: acct.code,
          name: acct.name,
          accountType: acct.accountType,
          isPosting: acct.isPosting,
          glTemplate: template,
          parentId: acct.parentCode ? codeToId[acct.parentCode] : undefined,
        }).onConflictDoNothing().returning(),
      );
      if (inserted) codeToId[acct.code] = inserted.id;
    }

    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "gl_account.template_imported", entityType: "gl_account", entityId: tenantId, newValues: { template, count: accounts.length } });
    res.json({ imported: Object.keys(codeToId).length, template });
  },
);

// ════════════════════════════════════════════════════════════════════════════
//  AUDIT TRAIL
// ════════════════════════════════════════════════════════════════════════════

router.get(
  "/master-data/audit-trail",
  ...tenantUserMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const entityType = req.query.entityType ? String(req.query.entityType) : undefined;
    const entityId = req.query.entityId ? String(req.query.entityId) : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    if (!entityType || !entityId) {
      res.status(400).json({ error: "entityType and entityId are required" });
      return;
    }

    const entries = await adminDb
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.tenantId, tenantId),
          eq(auditLogsTable.entityType, entityType),
          eq(auditLogsTable.entityId, entityId),
        ),
      )
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(limit);

    res.json({ entries });
  },
);

export default router;
