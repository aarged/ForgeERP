import {
  DocPage,
  DocSection,
  DocSubsection,
  P,
  Bullets,
  Steps,
  Callout,
  FieldTable,
  StatusTable,
  Code,
} from "../components";

export default function InventoryGuide() {
  return (
    <DocPage
      title="Inventory"
      intro="Inventory shows real-time stock across every warehouse, every movement that ever happened, and the tools to reconcile what the system says against what is physically on the shelf."
    >
      <DocSection title="The stock overview">
        <P>
          The default view lists every item with three columns that almost
          everyone needs:
        </P>
        <FieldTable
          rows={[
            {
              name: "On hand",
              type: "quantity",
              description:
                "Physical stock. Includes goods received but not yet picked or transferred away.",
            },
            {
              name: "Reserved",
              type: "quantity",
              description:
                "Allocated to confirmed sales orders that have not yet despatched.",
            },
            {
              name: "Available",
              type: "On hand − Reserved",
              description:
                "What can still be promised on a new sales order in this warehouse.",
            },
          ]}
        />
        <P>
          Filter by warehouse, item type, lot, or serial number from the bar at
          the top of the page.
        </P>
      </DocSection>

      <DocSection title="Movements log">
        <P>
          Every change to stock — receipts, despatches, transfers, adjustments,
          stocktakes — is recorded as a movement. The movements log is the
          forensic trail for "where did this stock come from / where did it go".
        </P>
        <FieldTable
          rows={[
            { name: "type", type: "receipt | despatch | transfer | adjustment | stocktake", description: "What kind of event happened." },
            { name: "qty", type: "signed quantity", description: "Positive for inbound, negative for outbound." },
            { name: "ref", type: "PO / SO / TRF / ADJ code", description: "Click-through to the source document." },
            { name: "user", type: "user id", description: "Who triggered the movement." },
            { name: "createdAt", type: "timestamp", description: "When it was committed." },
          ]}
        />
      </DocSection>

      <DocSection title="Stock adjustments">
        <P>
          Adjustments are for unexpected gains or losses outside the normal
          flow — breakage, found stock, expiry write-offs.
        </P>
        <Steps>
          <li>
            Go to <strong>Inventory → Adjustments → New</strong>.
          </li>
          <li>
            Pick the warehouse and the items. Enter the quantity delta (positive
            or negative) and a reason code.
          </li>
          <li>
            On save, stock changes immediately and a GL posting is created
            (DR/CR Inventory and the chosen variance account).
          </li>
        </Steps>
        <Callout kind="warning" title="Adjustments are audited">
          Every adjustment lands on the audit log with the user, time, and
          reason. Use the right reason code so the variance account stays
          informative.
        </Callout>
      </DocSection>

      <DocSection title="Warehouse transfers">
        <Steps>
          <li>
            Go to <strong>Inventory → Transfers → New</strong>. Pick the source
            and destination warehouses.
          </li>
          <li>
            Add lines and quantities. Save as <em>In Transit</em> — stock
            leaves the source warehouse and lands in a virtual transit
            location.
          </li>
          <li>
            When the receiving warehouse confirms arrival, click{" "}
            <strong>Receive</strong>. Stock moves from transit to the
            destination warehouse.
          </li>
        </Steps>
        <Callout kind="info" title="Why a transit step">
          Holding stock in transit means it can't be promised in either
          warehouse. ATP stays accurate even while a truck is on the road.
        </Callout>
      </DocSection>

      <DocSection title="Stocktake runs">
        <P>
          A full stocktake recounts every item in a warehouse and reconciles
          variances against the system.
        </P>
        <Steps>
          <li>
            Go to <strong>Inventory → Stocktakes → New Run</strong>. Pick the
            warehouse and a freeze date.
          </li>
          <li>
            The system snapshots current on-hand and generates count sheets
            (printable or in-app).
          </li>
          <li>
            Counters enter actual quantities. Variances are highlighted side by
            side with the system value.
          </li>
          <li>
            Review variances and click <strong>Post</strong>. Adjustments are
            generated automatically with reason <Code>STOCKTAKE</Code> and the
            run is closed.
          </li>
        </Steps>
      </DocSection>

      <DocSection title="Cycle counts">
        <P>
          A cycle count is a small, regular recount of a subset of items —
          typically high-velocity or high-value — without freezing the whole
          warehouse.
        </P>
        <Bullets>
          <li>
            Schedule on a cadence (daily, weekly, monthly) per item or item
            class.
          </li>
          <li>
            The dashboard surfaces overdue cycle counts on the warehouse role's
            tile.
          </li>
          <li>
            Variances post the same way as a full stocktake.
          </li>
        </Bullets>
      </DocSection>

      <DocSection title="Lot and serial tracking">
        <P>
          Items flagged as <Code>lotTracked</Code> or <Code>serialTracked</Code>{" "}
          in master data force every receipt, transfer, despatch, and
          adjustment to capture the relevant identifiers.
        </P>
        <FieldTable
          rows={[
            { name: "Lot", type: "string", description: "Batch identifier shared across many units. Useful for expiry tracking and recall." },
            { name: "Serial", type: "string, unique", description: "One identifier per physical unit. Required for warranty-tracked goods." },
            { name: "Expiry", type: "date", description: "Captured per lot. Reports surface lots expiring within a chosen window." },
          ]}
        />
        <Callout kind="warning" title="Cannot be retrofitted">
          Toggling lot or serial tracking on after stock has moved through the
          item is blocked. Decide at item setup time.
        </Callout>
      </DocSection>

      <DocSection title="Movement statuses">
        <StatusTable
          rows={[
            { status: "Draft", variant: "outline", description: "Saved but not yet committed. No stock impact." },
            { status: "Posted", variant: "default", description: "Stock and GL updated. Visible in reports." },
            { status: "In Transit", variant: "secondary", description: "Transfer-only. Stock has left source, not yet at destination." },
            { status: "Reversed", variant: "destructive", description: "A correction movement was posted. The original stays for audit." },
          ]}
        />
      </DocSection>
    </DocPage>
  );
}
