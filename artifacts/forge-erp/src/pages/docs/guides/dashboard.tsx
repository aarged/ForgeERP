import {
  DocPage,
  DocSection,
  DocSubsection,
  P,
  Bullets,
  Steps,
  Callout,
  FieldTable,
} from "../components";

export default function DashboardGuide() {
  return (
    <DocPage
      title="Dashboard"
      intro="The Dashboard is the first screen a user sees after sign-in. It surfaces the metrics and the to-do list that matter for that user's role, so the next action is always one click away."
    >
      <DocSection title="Purpose">
        <P>
          Forge ERP's dashboard is role-aware: a purchaser does not see a
          warehouse picker's queue, and an accountant does not see a sales
          discount approval. Each role gets a curated set of KPI cards and
          drilldown widgets.
        </P>
        <P>
          Underneath the role-specific section, every user can pin or unpin
          widgets so the dashboard ends up reflecting their personal day-to-day
          rhythm.
        </P>
      </DocSection>

      <DocSection title="What each role sees">
        <FieldTable
          nameHeader="Role"
          typeHeader="Headline KPIs"
          rows={[
            {
              name: "purchaser",
              type: "4 KPI tiles",
              description:
                "Open POs, requisitions awaiting approval, items still to receive, supplier spend month-to-date. Tile clicks open the matching procurement filter.",
            },
            {
              name: "warehouse",
              type: "4 KPI tiles",
              description:
                "Pick slips ready to start, items to receive today, low-stock alerts, pending cycle counts. The pick-slip tile deep-links into the Mobile PWA queue.",
            },
            {
              name: "approver",
              type: "Pending queue + history",
              description:
                "Approvals waiting on you, value pending, average turnaround time, and a feed of your most recent decisions. Click any item to jump to the approval screen.",
            },
            {
              name: "accountant",
              type: "Finance KPIs + cash flow",
              description:
                "GL postings today, unreconciled drafts, outstanding receivables, trial balance totals, and a month-to-date inflow / outflow estimate.",
            },
            {
              name: "tenant_admin / super_admin",
              type: "Composite",
              description:
                "Sees every tile from every role, plus tenant-health signals (active users, audit log volume, and onboarding completion if applicable).",
            },
          ]}
        />
      </DocSection>

      <DocSection title="Widgets and charts">
        <P>
          Below the KPI tiles, the dashboard renders a set of widgets that go
          deeper:
        </P>
        <Bullets>
          <li>
            <strong>Activity charts</strong> — bar and line charts showing
            month-on-month volume for the user's relevant module (e.g. POs
            placed per month for purchasers, GL postings per day for
            accountants).
          </li>
          <li>
            <strong>Top-N tables</strong> — for example, top suppliers by spend,
            top customers by revenue, or items with the largest stock variance.
          </li>
          <li>
            <strong>Alert lists</strong> — items below reorder point, invoices
            past due, requisitions older than the SLA, etc.
          </li>
        </Bullets>
      </DocSection>

      <DocSection title="Customising the dashboard">
        <Steps>
          <li>
            Click <strong>Customize</strong> in the top-right of the dashboard
            page.
          </li>
          <li>
            Toggle individual widgets on or off — the change saves to your user
            profile, not the tenant.
          </li>
          <li>
            Close the dialog. The dashboard re-renders with only the widgets
            you've kept.
          </li>
        </Steps>
        <Callout kind="info" title="Per-user only">
          Widget visibility is personal. Toggling off a tile does not hide it
          from other users in your tenant.
        </Callout>
      </DocSection>

      <DocSection title="Reading a KPI tile">
        <DocSubsection title="What the numbers mean">
          <P>
            Every tile shows a single headline number. Hovering over the tile
            shows the calculation period (today, MTD, etc.) in a tooltip.
            Currency tiles always render in the tenant's base currency.
          </P>
        </DocSubsection>
        <DocSubsection title="Drilling in">
          <P>
            Clicking a tile navigates to the underlying list with the right
            filter pre-applied. For example, clicking <em>Open POs</em> takes
            you to <strong>Procurement → Purchase Orders</strong> already
            filtered by status <em>Open</em>.
          </P>
        </DocSubsection>
      </DocSection>

      <DocSection title="When tiles show a dash">
        <P>
          A tile that displays "—" rather than a number means the underlying
          data has not yet loaded or there are no qualifying records. If the
          dash persists, check that you have the role access required for that
          metric.
        </P>
      </DocSection>
    </DocPage>
  );
}
