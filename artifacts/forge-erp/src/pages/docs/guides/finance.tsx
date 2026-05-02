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

export default function FinanceGuide() {
  return (
    <DocPage
      title="Finance"
      intro="Finance is where every financially significant event in the system lands. Most postings are created automatically by Procurement and Sales — accountants spend their time reviewing those, posting the occasional manual journal, and running the trial balance and account ledger."
    >
      <DocSection title="Chart of accounts">
        <P>
          The chart of accounts is maintained in <strong>Master Data</strong>{" "}
          (see that guide for the full field reference). The Finance module
          consumes it: every journal line picks a GL account from this list.
        </P>
        <Callout kind="warning" title="Control accounts are off-limits">
          AP, AR, and Inventory are <em>control</em> accounts. They are
          reconciled by upstream events (receipts, invoices, despatches) and
          cannot be posted to from a manual journal.
        </Callout>
      </DocSection>

      <DocSection title="Manual journal entries">
        <Steps>
          <li>
            Go to <strong>Finance → Journals → New</strong>.
          </li>
          <li>
            Enter the posting date and a memo. Add at least one debit line and
            one credit line — totals must balance to the cent before you can
            save.
          </li>
          <li>
            Save as <em>Draft</em> while you work, or click{" "}
            <strong>Submit</strong> to push it for approval (see thresholds
            below).
          </li>
          <li>
            Once approved (or self-approved if under the threshold), the
            journal posts to the GL and locks. Reversals are done with a new
            opposite journal, not by editing the original.
          </li>
        </Steps>
        <FieldTable
          rows={[
            { name: "postingDate", type: "date", description: "When the journal lands in the GL. Must fall in an open accounting period." },
            { name: "memo", type: "string", description: "Required. Surfaces in the account ledger so reviewers know what the entry is for." },
            { name: "lines[].account", type: "GL code", description: "Picked from the chart of accounts. Cannot be a control account." },
            { name: "lines[].debit / credit", type: "currency", description: "One per line. Total debit must equal total credit." },
            { name: "lines[].description", type: "string", description: "Optional per-line note." },
          ]}
        />
      </DocSection>

      <DocSection title="Approval thresholds">
        <P>
          Manual journals over the value threshold need a second pair of eyes
          before they post. The default policy:
        </P>
        <FieldTable
          nameHeader="Tier"
          typeHeader="Threshold (per journal)"
          rows={[
            { name: "Self-approved", type: "≤ 1,000", description: "Posts immediately after submit." },
            { name: "Approver", type: "1,001 – 25,000", description: "Routed to any user with the approver role." },
            { name: "Tenant admin", type: "> 25,000", description: "Requires tenant_admin sign-off in addition to the approver." },
          ]}
        />
        <Callout kind="info" title="Custom thresholds">
          The thresholds and approver mapping can be edited per tenant in{" "}
          <strong>Settings → Approvals</strong>.
        </Callout>
      </DocSection>

      <DocSection title="Automatic GL postings">
        <P>
          The vast majority of GL traffic comes from upstream module events.
          Each event posts a deterministic pair of debit / credit lines:
        </P>
        <FieldTable
          nameHeader="Event"
          typeHeader="Posting (DR / CR)"
          rows={[
            { name: "Goods Receipt (PO)", type: "DR Inventory / CR GR-IR", description: "GR-IR is cleared when the supplier bill is matched." },
            { name: "Supplier Bill", type: "DR GR-IR / CR Accounts Payable", description: "Closes the GR-IR loop opened at receipt." },
            { name: "Supplier Return", type: "DR GR-IR / CR Inventory", description: "Reverses the receipt." },
            { name: "Despatch (SO)", type: "DR COGS / CR Inventory", description: "Cost of goods sold is taken at despatch, not at invoice." },
            { name: "Customer Invoice", type: "DR Accounts Receivable / CR Revenue, CR Tax Payable", description: "Tax split out per line based on the item's tax code." },
            { name: "RMA / Credit Note", type: "DR Revenue / CR AR (and the COGS/Inventory leg if stock returned)", description: "Reverses invoice and (optionally) despatch." },
            { name: "Stock Adjustment", type: "DR/CR Inventory / DR/CR Variance Account", description: "Variance account chosen from the reason code mapping." },
          ]}
        />
        <Callout kind="success" title="Why GR-IR exists">
          Goods-Received-Invoice-Received bridges the gap between receiving
          stock and receiving the bill. A non-zero GR-IR balance at month-end
          shows what has arrived but not yet been billed (or vice versa) —
          essential for accruals.
        </Callout>
      </DocSection>

      <DocSection title="Trial balance">
        <P>
          The trial balance lists every GL account with its debit and credit
          totals as of a chosen date. Use it to verify the books balance and to
          spot accounts that look wrong before closing the period.
        </P>
        <Bullets>
          <li>
            Filter by accounting period or any custom date range.
          </li>
          <li>
            Drill into any account row to open the account ledger.
          </li>
          <li>
            Export to CSV or PDF for handoff to external auditors.
          </li>
        </Bullets>
      </DocSection>

      <DocSection title="Account ledger">
        <P>
          The account ledger is the per-account view of every posting that hit
          a particular GL account, with a running balance.
        </P>
        <Steps>
          <li>
            Click any account from the trial balance, or open it directly from{" "}
            <strong>Finance → Ledger</strong>.
          </li>
          <li>
            Each row links to the source document (PO, SO, invoice, journal)
            so you can trace the posting back to its origin.
          </li>
          <li>
            Filter by date range, source module, or counterparty.
          </li>
        </Steps>
      </DocSection>

      <DocSection title="Journal statuses">
        <StatusTable
          rows={[
            { status: "Draft", variant: "outline", description: "In progress. No GL impact." },
            { status: "Pending Approval", variant: "secondary", description: "Awaiting approver action. Read-only." },
            { status: "Posted", variant: "default", description: "Hit the GL. Locked — reverse with a new journal." },
            { status: "Rejected", variant: "destructive", description: "Approver declined. Stays in the audit log." },
          ]}
        />
      </DocSection>
    </DocPage>
  );
}
