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

export default function ProcurementGuide() {
  return (
    <DocPage
      title="Procurement"
      intro="Procurement covers the entire buy-side: deciding what to buy (Requisitions), getting sign-off (Approvals), placing the order (Purchase Orders), receiving the goods (Goods Receipt), and dealing with anything that has to go back (Supplier Returns)."
    >
      <DocSection title="The lifecycle, end to end">
        <P>
          Every purchase walks the same five stages. Each stage hands data to
          the next, so you never need to re-key information.
        </P>
        <Bullets>
          <li>
            <strong>Requisition</strong> — anyone with the purchaser role asks
            to buy something.
          </li>
          <li>
            <strong>Approval</strong> — the requisition is routed to the right
            approver based on value.
          </li>
          <li>
            <strong>Purchase Order</strong> — the approved requisition becomes
            an external order to a supplier.
          </li>
          <li>
            <strong>Goods Receipt</strong> — warehouse books the stock when it
            arrives. May be partial; the PO stays open until fully received.
          </li>
          <li>
            <strong>Supplier Return</strong> — when something is wrong, stock is
            sent back and the receipt is reversed.
          </li>
        </Bullets>
      </DocSection>

      <DocSection title="Raising a requisition">
        <Steps>
          <li>
            Go to <strong>Procurement → Requisitions</strong> and click{" "}
            <strong>New Requisition</strong>.
          </li>
          <li>
            Pick the destination warehouse and required-by date. Add line items
            from the master data picker — quantity and unit must be set on each
            line.
          </li>
          <li>
            Optionally suggest a preferred supplier. The buyer can override
            this when converting to a PO.
          </li>
          <li>
            Save as <em>Draft</em> if you're still working, or click{" "}
            <strong>Submit</strong> to send it for approval.
          </li>
        </Steps>
      </DocSection>

      <DocSection title="The approval workflow">
        <P>
          Requisitions route based on the total value and the tenant's approval
          policy. The default policy ships with three tiers:
        </P>
        <FieldTable
          nameHeader="Tier"
          typeHeader="Threshold"
          rows={[
            { name: "Tier 1", type: "≤ 1,000", description: "Single approver — the requester's manager." },
            { name: "Tier 2", type: "1,001 – 10,000", description: "Manager + finance approver." },
            { name: "Tier 3", type: "> 10,000", description: "Manager + finance + tenant admin." },
          ]}
        />
        <Callout kind="info" title="Approval order matters">
          Tiers run in sequence — finance only sees the requisition once the
          manager has approved it. Any approver can reject at any tier; this
          short-circuits the rest of the chain.
        </Callout>
        <DocSubsection title="What an approver sees">
          <Bullets>
            <li>A queue of items waiting on them, with value and requester.</li>
            <li>Full line detail and the requester's notes.</li>
            <li>
              Three actions: <strong>Approve</strong>, <strong>Reject</strong>{" "}
              (must include a reason), and <strong>Send back</strong> (returns
              the requisition to the requester for edits).
            </li>
          </Bullets>
        </DocSubsection>
      </DocSection>

      <DocSection title="Requisition statuses">
        <StatusTable
          rows={[
            { status: "Draft", variant: "outline", description: "Saved but not yet submitted. Editable by the requester." },
            { status: "Pending Approval", variant: "secondary", description: "In the approval chain. Read-only for the requester." },
            { status: "Approved", variant: "default", description: "Cleared all approval tiers and can be converted to a PO." },
            { status: "Rejected", variant: "destructive", description: "Closed. Reason captured on the audit trail." },
            { status: "Converted", variant: "default", description: "Linked to a PO. No further edits possible." },
          ]}
        />
      </DocSection>

      <DocSection title="Converting to a purchase order">
        <Steps>
          <li>
            Open an <em>Approved</em> requisition and click{" "}
            <strong>Convert to PO</strong>.
          </li>
          <li>
            Choose the supplier (defaults to the suggested one if any) and
            confirm pricing. The buyer can adjust line quantities downward but
            not above the approved values without re-approval.
          </li>
          <li>
            The PO is created in <em>Open</em> status and emailed to the
            supplier.
          </li>
        </Steps>
      </DocSection>

      <DocSection title="Purchase order statuses">
        <StatusTable
          rows={[
            { status: "Open", variant: "secondary", description: "Sent to the supplier, awaiting any goods receipt." },
            { status: "Partially Received", variant: "secondary", description: "At least one line has been partly received; PO stays open." },
            { status: "Received", variant: "default", description: "Every line fully received. The PO is closed for receipts but stays available for matching." },
            { status: "Cancelled", variant: "destructive", description: "Closed before any receipt. Cancelling after a receipt is not allowed; raise a return instead." },
          ]}
        />
      </DocSection>

      <DocSection title="Booking a goods receipt">
        <Steps>
          <li>
            Open the PO and click <strong>Receive</strong>, or start from{" "}
            <strong>Procurement → Goods Receipts → New</strong> and pick the
            PO.
          </li>
          <li>
            Enter the quantity received per line. Defaults to the outstanding
            quantity but can be lower for partial receipts.
          </li>
          <li>
            For lot- or serial-tracked items, capture the lot/serial numbers in
            the line drawer.
          </li>
          <li>
            Save. Stock on-hand is increased instantly, and a GL posting is
            created automatically (DR Inventory / CR GR-IR).
          </li>
        </Steps>
        <Callout kind="success" title="Partial receipts">
          You can receive against the same PO multiple times. The PO stays
          <Code>Partially Received</Code> until every line's open quantity is
          zero.
        </Callout>
      </DocSection>

      <DocSection title="Supplier returns">
        <Steps>
          <li>
            From the PO or goods receipt, click <strong>Return to supplier</strong>.
          </li>
          <li>
            Pick the lines to return, the quantity, and a reason (damaged,
            wrong item, over-shipped, etc.).
          </li>
          <li>
            On save, stock is reduced from the receiving warehouse and a
            reversing GL entry is posted (DR GR-IR / CR Inventory).
          </li>
        </Steps>
        <Callout kind="warning" title="Returns are stock-aware">
          You can only return what is still on hand from that receipt. If the
          stock has already been picked or transferred, the return is blocked
          and you must adjust stock first.
        </Callout>
      </DocSection>

      <DocSection title="Where the numbers go">
        <P>
          Every receipt and return creates an automatic posting. You can see
          the audit trail on each PO and the matching journal entry in the
          Finance module's account ledger.
        </P>
      </DocSection>
    </DocPage>
  );
}
