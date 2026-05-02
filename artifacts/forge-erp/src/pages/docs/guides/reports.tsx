import {
  DocPage,
  DocSection,
  DocSubsection,
  P,
  Bullets,
  Callout,
  FieldTable,
} from "../components";

export default function ReportsGuide() {
  return (
    <DocPage
      title="Reports"
      intro="The Reports module is one screen with many tabs — every recurring question about stock, procurement, sales, or finance has a saved answer here. Each report supports the same standard pattern: filter, view on-screen, and export to CSV or PDF."
    >
      <DocSection title="How to use any report">
        <Bullets>
          <li>
            Pick the report from the tab list across the top.
          </li>
          <li>
            Set the filters in the header bar (date range, warehouse, supplier,
            customer, etc.).
          </li>
          <li>
            Read the table on screen, or click <strong>Export CSV</strong> or{" "}
            <strong>Export PDF</strong> to download.
          </li>
        </Bullets>
        <Callout kind="info" title="Exports honour your filters">
          The CSV and PDF download exactly what you see on screen. Apply
          filters first, then click export.
        </Callout>
      </DocSection>

      <DocSection title="Inventory reports">
        <DocSubsection title="Stock valuation">
          <P>
            Shows the value of on-hand stock per item per warehouse using the
            tenant's chosen costing method (moving average by default).
          </P>
          <FieldTable
            nameHeader="Filter"
            typeHeader="Effect"
            rows={[
              { name: "As-of date", description: "Snapshots the valuation at that point in time using historical movements." },
              { name: "Warehouse", description: "Restricts to one location, or roll-up across all warehouses." },
              { name: "Item filter", description: "Search by code, name, or category to narrow the list." },
            ]}
          />
        </DocSubsection>

        <DocSubsection title="Movement history">
          <P>
            Every stock movement (receipt, despatch, transfer, adjustment) for
            the chosen items in the chosen window. Use this to forensically
            answer "what happened to this stock between these dates".
          </P>
        </DocSubsection>

        <DocSubsection title="Slow-moving stock">
          <P>
            Items that have not despatched in N days, with their on-hand value.
            Use to flag candidates for clearance, write-off, or reorder
            adjustment.
          </P>
        </DocSubsection>

        <DocSubsection title="Goods-in-transit">
          <P>
            Stock currently in the virtual transit warehouse — i.e. transfers
            that have left source but not yet arrived at destination.
          </P>
        </DocSubsection>

        <DocSubsection title="Stocktake variance">
          <P>
            For each completed stocktake or cycle count: counted vs system
            quantity, value of the variance, and the reason code.
          </P>
        </DocSubsection>
      </DocSection>

      <DocSection title="Procurement reports">
        <DocSubsection title="PO summary">
          <P>
            One row per PO with status, total value, supplier, days since
            issue, and percent received. Filter by status to see open vs
            closed.
          </P>
        </DocSubsection>

        <DocSubsection title="PO aging">
          <P>
            Buckets open POs by age (0–30, 31–60, 61–90, 90+ days since order
            date). Use to chase stale orders.
          </P>
        </DocSubsection>

        <DocSubsection title="Supplier performance">
          <P>
            Per supplier: order count, on-time delivery rate, fill rate
            (received vs ordered), and return rate.
          </P>
        </DocSubsection>

        <DocSubsection title="Goods receipt note (GRN) report">
          <P>
            All goods receipts in the window with the source PO, supplier,
            warehouse, and value received. The accountant's view of incoming
            stock.
          </P>
        </DocSubsection>
      </DocSection>

      <DocSection title="Sales reports">
        <DocSubsection title="Revenue by period">
          <P>
            Total invoiced revenue grouped by day, week, month, or quarter. The
            chart at the top of the page shows the trend; the table below
            breaks down each period.
          </P>
        </DocSubsection>

        <DocSubsection title="Revenue by item">
          <P>
            Sales totals per item across the window. Use to identify your best
            sellers (or the long tail).
          </P>
        </DocSubsection>

        <DocSubsection title="Revenue by customer">
          <P>
            Per customer: invoice count, total revenue, average order value,
            and outstanding balance.
          </P>
        </DocSubsection>

        <DocSubsection title="Backorder">
          <P>
            Sales order lines where requested quantity exceeds available stock,
            with the shortfall and the earliest inbound PO that could fulfil
            it.
          </P>
        </DocSubsection>
      </DocSection>

      <DocSection title="Finance reports">
        <DocSubsection title="Invoice aging">
          <P>
            Outstanding customer invoices bucketed by days overdue (current,
            1–30, 31–60, 61–90, 90+). The collections team's primary report.
          </P>
        </DocSubsection>
        <Callout kind="info" title="Trial balance and account ledger">
          These two are part of the Finance module rather than the Reports
          module — see the <strong>Finance</strong> guide.
        </Callout>
      </DocSection>

      <DocSection title="Reading exports">
        <Bullets>
          <li>
            <strong>CSV</strong> — raw data; columns match what's on screen.
            Open in any spreadsheet tool.
          </li>
          <li>
            <strong>PDF</strong> — formatted for printing, with the tenant
            header, the filter summary, and page numbers.
          </li>
        </Bullets>
      </DocSection>
    </DocPage>
  );
}
