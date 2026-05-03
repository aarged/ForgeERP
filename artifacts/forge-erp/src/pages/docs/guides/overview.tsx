import {
  ShoppingCart,
  Receipt,
  PackageSearch,
  Calculator,
  BarChart3,
  Database,
  LayoutDashboard,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DocPage,
  DocSection,
  DocSubsection,
  P,
  Bullets,
  Callout,
  FieldTable,
  Code,
} from "../components";

const modules = [
  {
    icon: LayoutDashboard,
    name: "Dashboard",
    blurb: "Role-aware KPIs and widgets that surface the next thing to do.",
  },
  {
    icon: Database,
    name: "Master Data",
    blurb:
      "Items, suppliers, customers, warehouses, and the chart of accounts.",
  },
  {
    icon: ShoppingCart,
    name: "Procurement",
    blurb: "Requisitions, approvals, purchase orders, goods receipts, returns.",
  },
  {
    icon: Receipt,
    name: "Sales",
    blurb: "Quotations, sales orders, pick slips, despatch, invoices, RMAs.",
  },
  {
    icon: PackageSearch,
    name: "Inventory",
    blurb: "On-hand stock, movements, transfers, stocktakes, lots and serials.",
  },
  {
    icon: Calculator,
    name: "Finance",
    blurb: "Chart of accounts, journals, GL postings, trial balance.",
  },
  {
    icon: BarChart3,
    name: "Reports",
    blurb: "Stock, procurement, sales, and financial reporting with exports.",
  },
];

export default function OverviewGuide() {
  return (
    <DocPage
      title="Product Overview"
      intro="Forge ERP is a multi-tenant business platform that connects the whole supply-chain loop — from raising a requisition to receiving stock, picking a sales order, despatching it, and posting the journal entries. This page explains what the modules do, how they fit together, and which roles drive each part of the workflow."
    >
      <DocSection title="What Forge ERP is">
        <P>
          Forge ERP is an Enterprise Resource Planning system tailored for
          small-to-mid-size product companies. It centralises master data,
          enforces approval policy, tracks stock in real time, and posts every
          financially significant event to the general ledger automatically.
        </P>
        <P>
          Each customer (a "tenant") gets a fully isolated workspace — own
          users, own data, own settings. Within a tenant, individual users are
          assigned roles that determine what they see and what they can do.
        </P>
      </DocSection>

      <DocSection title="The module map">
        <P>
          The app is organised into eight modules. The sidebar on the left of
          every page is the entry point to each.
        </P>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-4">
          {modules.map((m) => (
            <Card key={m.name}>
              <CardContent className="p-4 flex gap-3">
                <m.icon className="size-5 text-primary mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold text-sm">{m.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {m.blurb}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <P>
          A separate <strong>Mobile Picking PWA</strong> at <Code>/picking</Code>{" "}
          is a tablet-friendly companion app for warehouse staff. The{" "}
          <strong>Administration</strong> screens (Settings, Members, Audit Log,
          Onboarding) live alongside the modules and are gated to admin roles.
        </P>
      </DocSection>

      <DocSection title="Roles and what they typically do">
        <FieldTable
          nameHeader="Role"
          typeHeader="Scope"
          rows={[
            {
              name: "global_admin",
              type: "All tenants",
              description:
                "Replit/Forge platform staff. Sees every tenant via the Global Admin console; can impersonate, view audit logs, and manage tenant lifecycle. All other module access also granted.",
            },
            {
              name: "tenant_admin",
              type: "Single tenant",
              description:
                "The customer's own administrator. Manages users, roles, master data, and tenant-wide settings. Has access to every module within their tenant.",
            },
            {
              name: "purchaser",
              type: "Procurement",
              description:
                "Raises requisitions, converts approved requisitions to POs, places orders with suppliers, follows up on outstanding deliveries, and processes supplier returns.",
            },
            {
              name: "warehouse",
              type: "Inventory + Mobile",
              description:
                "Books goods receipts, runs stock adjustments and transfers, performs stocktakes and cycle counts, and uses the Mobile PWA to pick sales orders.",
            },
            {
              name: "approver",
              type: "Procurement / Sales / Finance",
              description:
                "Reviews and decides requisitions, sales discounts above policy, and high-value journal entries. Sees the queue of pending items routed to them.",
            },
            {
              name: "accountant",
              type: "Finance + Master Data",
              description:
                "Posts manual journals, reviews automatic GL postings, runs the trial balance and account ledgers, and maintains the chart of accounts.",
            },
          ]}
        />
        <Callout kind="info" title="Read-only viewers">
          A user without an assigned role (the default after invitation, before
          a tenant admin promotes them) sees the dashboard only and cannot edit
          data. This keeps onboarding safe by default.
        </Callout>
      </DocSection>

      <DocSection title="How the modules connect">
        <P>
          Forge ERP enforces an end-to-end flow so that procurement, inventory,
          and finance always agree. Below is the canonical happy path for a
          purchase and a sale.
        </P>

        <DocSubsection title="Procurement → Inventory → Finance">
          <FlowDiagram
            steps={[
              { label: "Requisition", note: "raised by purchaser" },
              { label: "Approval", note: "routed to approver" },
              { label: "Purchase Order", note: "sent to supplier" },
              { label: "Goods Receipt", note: "booked by warehouse" },
              { label: "Stock On-Hand ↑", note: "Inventory updated" },
              { label: "GL Posting", note: "DR Inventory / CR GR-IR" },
            ]}
          />
        </DocSubsection>

        <DocSubsection title="Sales → Inventory → Finance">
          <FlowDiagram
            steps={[
              { label: "Quotation", note: "optional" },
              { label: "Sales Order", note: "ATP check" },
              { label: "Pick Slip", note: "Mobile PWA" },
              { label: "Despatch", note: "warehouse out" },
              { label: "Stock On-Hand ↓", note: "Inventory updated" },
              { label: "Customer Invoice", note: "AR posted" },
            ]}
          />
        </DocSubsection>

        <Callout kind="tip" title="Why this matters">
          Because each stage hands data to the next, you almost never have to
          re-key information. A goods receipt automatically updates stock and
          posts to the GL; a despatch automatically reduces stock and seeds the
          invoice. If a stage is skipped (e.g. a PO that was never received but
          paid for), the corresponding numbers will go out of sync — the audit
          log and trial balance are designed to surface this.
        </Callout>
      </DocSection>

      <DocSection title="Where to go next">
        <Bullets>
          <li>
            Brand new to the app? Start with the <strong>Dashboard</strong>{" "}
            guide to understand what each role sees first.
          </li>
          <li>
            Setting up a tenant? Read the <strong>Master Data</strong> guide and
            the <strong>Administration</strong> guide.
          </li>
          <li>
            Working in the warehouse? See the{" "}
            <strong>Mobile Picking PWA</strong> guide.
          </li>
          <li>
            Looking up a specific number on a report? Jump to the{" "}
            <strong>Reports</strong> guide.
          </li>
        </Bullets>
      </DocSection>
    </DocPage>
  );
}

function FlowDiagram({
  steps,
}: {
  steps: { label: string; note?: string }[];
}) {
  return (
    <div className="my-4 rounded-md border bg-muted/30 p-4">
      <div className="flex flex-wrap items-stretch gap-2">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-stretch gap-2">
            <div className="flex flex-col items-center justify-center rounded-md border bg-background px-3 py-2 min-w-[120px]">
              <Badge variant="secondary" className="mb-1 font-medium">
                {s.label}
              </Badge>
              {s.note && (
                <span className="text-[11px] text-muted-foreground text-center">
                  {s.note}
                </span>
              )}
            </div>
            {i < steps.length - 1 && (
              <ArrowRight className="size-4 text-muted-foreground self-center" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
