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

export default function SalesGuide() {
  return (
    <DocPage
      title="Sales"
      intro="Sales covers the full sell-side: drafting a quotation, turning it into a sales order, picking and despatching the goods, raising the invoice, and processing returns. Stock and the GL stay in step automatically."
    >
      <DocSection title="The sales lifecycle">
        <Bullets>
          <li>
            <strong>Quotation</strong> — optional. A priced offer to a customer
            that does not reserve stock.
          </li>
          <li>
            <strong>Sales Order (SO)</strong> — confirms the deal and runs an
            ATP (available-to-promise) check.
          </li>
          <li>
            <strong>Pick Slip</strong> — the warehouse instruction to
            physically gather the items, used in the Mobile Picking PWA.
          </li>
          <li>
            <strong>Despatch</strong> — confirms what left the warehouse and
            decrements stock.
          </li>
          <li>
            <strong>Invoice</strong> — bills the customer; AR is posted.
          </li>
          <li>
            <strong>Credit Note / RMA</strong> — for returns, refunds, or
            disputed amounts.
          </li>
        </Bullets>
      </DocSection>

      <DocSection title="Quotations">
        <Steps>
          <li>
            Go to <strong>Sales → Quotations → New</strong>. Pick the customer
            and an expiry date.
          </li>
          <li>
            Add line items. Prices default from the item master but can be
            overridden. Discounts above the policy threshold trigger an
            approval requirement.
          </li>
          <li>
            Save as <em>Draft</em>, then click <strong>Send</strong> when
            ready. The quotation is emailed to the customer's billing contact.
          </li>
          <li>
            When the customer accepts, click <strong>Convert to Sales Order</strong>{" "}
            from the quotation.
          </li>
        </Steps>
      </DocSection>

      <DocSection title="Sales orders and the ATP check">
        <P>
          When you save a sales order, Forge ERP runs an{" "}
          <strong>available-to-promise</strong> calculation per line:
        </P>
        <FieldTable
          nameHeader="Quantity"
          typeHeader="Definition"
          rows={[
            { name: "On hand", description: "Physical stock in the chosen warehouse." },
            { name: "Reserved", description: "Already allocated to other open sales orders." },
            { name: "Inbound", description: "Open POs due in before the order's required-by date." },
            { name: "ATP", description: "On hand − Reserved + Inbound (capped at 0)." },
          ]}
        />
        <Callout kind="warning" title="Insufficient stock">
          If ATP is below the requested quantity, the line is flagged. You can
          still save the order — the shortfall lands on the{" "}
          <strong>Backorder</strong> report so procurement can react.
        </Callout>
      </DocSection>

      <DocSection title="Sales order statuses">
        <StatusTable
          rows={[
            { status: "Draft", variant: "outline", description: "Editable, not yet committed. No stock reserved." },
            { status: "Confirmed", variant: "secondary", description: "Stock reserved against on-hand. Pick slips can be generated." },
            { status: "Picking", variant: "secondary", description: "At least one pick slip in progress in the warehouse." },
            { status: "Despatched", variant: "default", description: "Goods left the building. Invoice can now be raised." },
            { status: "Invoiced", variant: "default", description: "Customer invoice issued. SO is closed." },
            { status: "Cancelled", variant: "destructive", description: "Cancelled before despatch. Reservations released." },
          ]}
        />
      </DocSection>

      <DocSection title="Pick slips">
        <Steps>
          <li>
            From a confirmed SO, click <strong>Generate Pick Slip</strong>. One
            slip per warehouse is created.
          </li>
          <li>
            Optionally assign the slip to a picker user. The Mobile Picking PWA
            shows assigned slips first.
          </li>
          <li>
            The picker walks the route in the PWA and confirms each line.
            Variances (short or over picks) are captured on the slip.
          </li>
          <li>
            On <strong>Complete</strong>, the slip closes. Once every slip on
            the SO is complete, the SO becomes ready to despatch.
          </li>
        </Steps>
        <Callout kind="info" title="Where to follow progress">
          Supervisors monitor active slips on the picker progress board (see
          the <strong>Mobile Picking PWA</strong> guide).
        </Callout>
      </DocSection>

      <DocSection title="Despatch">
        <Steps>
          <li>
            On the SO, click <strong>Despatch</strong>. The despatch dialog
            shows what has been picked.
          </li>
          <li>
            Confirm carrier, tracking number, and any documentation.
          </li>
          <li>
            On save, stock is decremented from the source warehouse and the GL
            posting is created (DR COGS / CR Inventory).
          </li>
        </Steps>
      </DocSection>

      <DocSection title="Invoicing and credit notes">
        <DocSubsection title="Customer invoice">
          <Steps>
            <li>
              From the despatched SO, click <strong>Raise Invoice</strong>.
              The invoice inherits the line detail and customer payment terms.
            </li>
            <li>
              Review and click <strong>Issue</strong>. The invoice is emailed
              to the billing contact and posted to AR (DR AR / CR Revenue,
              with tax split off).
            </li>
          </Steps>
        </DocSubsection>
        <DocSubsection title="Credit note">
          <P>
            A credit note reverses an invoice in part or in full. Use it for
            disputed amounts, allowances, or write-offs that do <em>not</em>{" "}
            involve physical stock movement (those go through the RMA flow
            instead).
          </P>
        </DocSubsection>
      </DocSection>

      <DocSection title="RMA (Returns from customers)">
        <Steps>
          <li>
            From the invoice, click <strong>Start RMA</strong>. Select the
            lines and quantity being returned, plus a reason.
          </li>
          <li>
            On approval, the system creates a return receipt — stock is added
            back to the chosen warehouse (often a quarantine warehouse) and a
            credit note is generated against the original invoice.
          </li>
          <li>
            If the goods are unsellable, raise a stock adjustment from the
            quarantine warehouse to write them off.
          </li>
        </Steps>
        <Callout kind="warning" title="RMA vs credit note">
          Use a plain credit note when no goods come back. Use the RMA flow
          when stock physically returns — only that path keeps inventory and
          the GL aligned.
        </Callout>
      </DocSection>
    </DocPage>
  );
}
