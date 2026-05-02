import {
  DocPage,
  DocSection,
  DocSubsection,
  P,
  Bullets,
  Steps,
  Callout,
  FieldTable,
  Code,
} from "../components";

export default function MasterDataGuide() {
  return (
    <DocPage
      title="Master Data"
      intro="Master Data is the source-of-truth for everything the rest of the app talks about: the products you sell, who you buy from, who you sell to, where stock lives, and the accounts you post to. Get this right early and the rest of the app stays clean."
    >
      <DocSection title="Purpose">
        <P>
          The Master Data module groups five related lists under a single
          tabbed page: <strong>Items</strong>, <strong>Suppliers</strong>,{" "}
          <strong>Customers</strong>, <strong>Warehouses</strong>, and the{" "}
          <strong>Chart of Accounts</strong>. Each tab supports create, edit,
          archive, bulk import, and bulk export.
        </P>
        <Callout kind="warning" title="Codes are forever">
          Once an item, supplier, customer, or warehouse code is referenced by a
          transaction (a PO, a journal, a receipt), it can no longer be
          renamed. Pick a coding convention before you load production data.
        </Callout>
      </DocSection>

      <DocSection title="Items and variants">
        <P>
          An <em>item</em> is a sellable or stockable product. Items have a
          unique code, a description, a unit of measure, and (optionally) a
          parent for variants (e.g. a t-shirt with size + colour variants).
        </P>
        <FieldTable
          rows={[
            {
              name: "code",
              type: "string, unique",
              description: (
                <>
                  Stable identifier shown on every transaction. Cannot be
                  changed once used. Convention: short, uppercase, no spaces
                  (e.g. <Code>SKU-1042-BLK-M</Code>).
                </>
              ),
            },
            {
              name: "name",
              type: "string",
              description: "Human-readable description; shown to customers on quotes and invoices.",
            },
            {
              name: "uom",
              type: "EA, KG, L, BOX, …",
              description: "Unit of measure. Stock and pricing are tracked in this unit.",
            },
            {
              name: "type",
              type: "stock | non-stock | service",
              description: (
                <>
                  Stockable items affect inventory and the GL. <em>Service</em>{" "}
                  items appear on invoices but never touch stock.
                </>
              ),
            },
            {
              name: "reorderPoint",
              type: "number",
              description: "Triggers low-stock alerts on the dashboard and in reports.",
            },
            {
              name: "lotTracked / serialTracked",
              type: "boolean",
              description:
                "Forces every receipt and despatch to capture lot or serial numbers. Cannot be toggled once stock has moved.",
            },
            {
              name: "defaultGlAccount",
              type: "GL code",
              description:
                "Account hit when this item moves through procurement or sales (overrides the tenant default).",
            },
          ]}
        />
        <DocSubsection title="Variants">
          <P>
            Variants share a parent item but have their own code, attributes
            (size, colour, etc.), price, and stock. Use them for SKUs that are
            commercially the same product but physically distinct.
          </P>
        </DocSubsection>
      </DocSection>

      <DocSection title="Suppliers">
        <FieldTable
          rows={[
            { name: "code", type: "string, unique", description: "Internal supplier identifier." },
            { name: "name", type: "string", description: "Legal business name as shown on POs." },
            { name: "taxId", type: "string", description: "Validated against the tax authority registry during onboarding." },
            { name: "paymentTerms", type: "Net 7 / 14 / 30 / 60 / 90", description: "Default terms applied to new POs and used to age payables." },
            { name: "currency", type: "ISO 4217", description: "Trading currency. POs and bills are issued in this currency." },
            { name: "status", type: "active | hold | archived", description: "Suppliers on hold cannot have new POs raised against them." },
          ]}
        />
      </DocSection>

      <DocSection title="Customers">
        <FieldTable
          rows={[
            { name: "code", type: "string, unique", description: "Internal customer identifier." },
            { name: "name", type: "string", description: "Legal name on quotes and invoices." },
            { name: "creditLimit", type: "currency", description: "Sales orders blocked above this outstanding balance." },
            { name: "paymentTerms", type: "Net 7 / 14 / 30 / 60", description: "Drives the invoice due date and AR aging." },
            { name: "shipTo / billTo", type: "address", description: "Defaults applied when creating a new sales order." },
          ]}
        />
      </DocSection>

      <DocSection title="Warehouses">
        <P>
          A warehouse is any physical or logical location stock can sit in.
          Most tenants have one main warehouse plus a returns/quarantine
          location. You can have as many as you need.
        </P>
        <FieldTable
          rows={[
            { name: "code", type: "string, unique", description: "Used to qualify on-hand balances and movements." },
            { name: "name", type: "string", description: "Display name (e.g. \"Main DC – Auckland\")." },
            { name: "type", type: "physical | quarantine | transit", description: "Quarantine stock is excluded from ATP; transit stock is for in-flight transfers." },
            { name: "isDefault", type: "boolean", description: "One warehouse per tenant can be marked as the default for new POs and SOs." },
          ]}
        />
      </DocSection>

      <DocSection title="Chart of accounts">
        <P>
          The Chart of Accounts (COA) defines every GL account the system can
          post to. A standard COA is seeded during onboarding; you can add,
          rename, or archive accounts here.
        </P>
        <FieldTable
          rows={[
            { name: "code", type: "string, unique", description: "Account number, e.g. 1000 for Cash." },
            { name: "name", type: "string", description: "Account label." },
            {
              name: "type",
              type: "asset | liability | equity | revenue | expense",
              description: "Determines normal balance and where the account appears on the trial balance.",
            },
            { name: "parent", type: "GL code", description: "Optional, for grouping in the trial balance." },
            { name: "isControl", type: "boolean", description: "Control accounts (AP, AR, Inventory) are auto-posted by Procurement and Sales — do not journal directly." },
          ]}
        />
        <Callout kind="warning" title="Don't journal a control account">
          Manual journals against AP, AR, or Inventory will fail validation.
          These balances are reconciled automatically by upstream module events.
        </Callout>
      </DocSection>

      <DocSection title="Bulk import / export">
        <Steps>
          <li>
            Open the relevant tab and click <strong>Export</strong> to
            download the current contents as CSV or XLSX. Use this as your
            template — it already has the right columns.
          </li>
          <li>
            Edit in your spreadsheet of choice. Leave the <Code>code</Code>{" "}
            column empty for new rows; fill it in to update an existing row.
          </li>
          <li>
            Click <strong>Import</strong> and upload the file. The system
            validates every row before any are committed and shows a
            row-by-row error report on failure.
          </li>
          <li>
            Review the proposed changes in the preview dialog and confirm to
            commit.
          </li>
        </Steps>
        <Callout kind="tip" title="Dry-run first">
          Use the <strong>Validate only</strong> checkbox on the import dialog
          when loading a large file. The system reports what it would do
          without writing anything.
        </Callout>
      </DocSection>
    </DocPage>
  );
}
