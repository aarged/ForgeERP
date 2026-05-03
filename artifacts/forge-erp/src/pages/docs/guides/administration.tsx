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

export default function AdministrationGuide() {
  return (
    <DocPage
      title="Administration"
      intro="Administration covers the cross-cutting things tenant admins and global-admins do: setting up new tenants, inviting users, deciding who can do what, and reviewing the audit log when something needs explaining."
    >
      <DocSection title="The tenant onboarding wizard">
        <P>
          When a new company signs up, the <strong>Onboarding Wizard</strong>{" "}
          walks the first user through everything required to start
          transacting. It can be paused and resumed; the next user with the{" "}
          <Code>tenant_admin</Code> role lands back on the same step.
        </P>
        <Steps>
          <li>
            <strong>Company profile</strong> — legal name, country, tax ID
            (validated against the local registry), base currency, and brand
            colour.
          </li>
          <li>
            <strong>Plan and billing</strong> — choose a subscription plan; if
            paid, payment is collected before continuing.
          </li>
          <li>
            <strong>Master data</strong> — start from a template chart of
            accounts, optionally upload an items / suppliers / customers CSV,
            and define at least one warehouse.
          </li>
          <li>
            <strong>Invite team</strong> — add colleagues by email and pick
            their role. Invitations are emailed; accepting links the new user
            to the tenant.
          </li>
          <li>
            <strong>Finish</strong> — the wizard hands the user to the
            dashboard and the tenant is fully active.
          </li>
        </Steps>
        <Callout kind="info" title="Resuming onboarding">
          Closing the browser at any point saves progress. The same user (or
          any other tenant_admin) is taken back to the next incomplete step on
          their next sign-in.
        </Callout>
      </DocSection>

      <DocSection title="Roles and permissions">
        <P>
          Forge ERP uses role-based access control with the roles described in
          the <strong>Product Overview</strong>. A user has exactly one role
          per tenant (a user can belong to multiple tenants with different
          roles in each).
        </P>
        <FieldTable
          nameHeader="Action"
          typeHeader="Roles allowed"
          rows={[
            { name: "View dashboard", description: "All authenticated users." },
            { name: "Edit master data", type: "tenant_admin, accountant", description: "Items, suppliers, customers, warehouses, COA." },
            { name: "Raise requisition / PO", type: "purchaser, tenant_admin", description: "Procurement workflow." },
            { name: "Approve requisition / journal", type: "approver, tenant_admin", description: "Routed by value thresholds." },
            { name: "Book goods receipt / pick", type: "warehouse, tenant_admin", description: "Inventory and Mobile PWA." },
            { name: "Post manual journal", type: "accountant, tenant_admin", description: "Approval rules apply above the threshold." },
            { name: "Manage members & invites", type: "tenant_admin", description: "Add, remove, change role, resend invite." },
            { name: "View audit log", type: "tenant_admin, global_admin", description: "Tenant admin sees their tenant; global_admin sees all." },
            { name: "Cross-tenant operations", type: "global_admin only", description: "Impersonation, tenant lifecycle, billing reconciliation." },
          ]}
        />
      </DocSection>

      <DocSection title="Inviting members">
        <Steps>
          <li>
            Go to <strong>Settings → Members → Invite</strong>.
          </li>
          <li>
            Enter the invitee's email and pick the role they should have on
            arrival. You can invite several at once.
          </li>
          <li>
            The invite email contains a link to <Code>/sign-up</Code> with the
            address pre-filled. When they complete sign-up, they're matched to
            the invitation by verified email.
          </li>
          <li>
            Pending invites are listed on the Members page with a{" "}
            <strong>Resend</strong> and <strong>Revoke</strong> action.
          </li>
        </Steps>
        <Callout kind="tip" title="Changing a role later">
          Open the user's row on the Members page and pick a new role from the
          dropdown. The change takes effect on their next request — no sign-out
          needed.
        </Callout>
      </DocSection>

      <DocSection title="Audit log viewer">
        <P>
          The audit log records every state-changing action: who did what, to
          what entity, when, and what changed. It is read-only and immutable.
        </P>
        <FieldTable
          rows={[
            { name: "actor", type: "user id", description: "The user who performed the action. \"system\" for automated jobs." },
            { name: "action", type: "create | update | delete | submit | approve | reject | post", description: "What kind of operation it was." },
            { name: "entityType", type: "po | so | journal | …", description: "The kind of record affected." },
            { name: "entityCode", type: "string", description: "Click-through to the record." },
            { name: "before / after", type: "JSON diff", description: "What the field values looked like before and after." },
            { name: "createdAt", type: "timestamp", description: "When the event was recorded." },
          ]}
        />
        <Bullets>
          <li>
            Filter by actor, entity type, action, and date range.
          </li>
          <li>
            Tenant admins see audit events for their tenant only. Global-admins
            can switch tenant or view across all.
          </li>
          <li>
            Export to CSV for compliance reviews.
          </li>
        </Bullets>
        <Callout kind="warning" title="The audit log cannot be edited">
          Even tenant admins cannot delete or amend audit entries. If a record
          looks wrong, raise a corrective transaction in the relevant module —
          the corrective action will itself be audited.
        </Callout>
      </DocSection>

      <DocSection title="Global Admin console">
        <P>
          Users with the <Code>global_admin</Code> role get an extra menu entry
          for the cross-tenant console. From there, they can:
        </P>
        <Bullets>
          <li>
            Browse every tenant, see plan/usage, and impersonate a tenant_admin
            for support.
          </li>
          <li>
            View the global audit log filtered by tenant or actor.
          </li>
          <li>
            Issue direct invites into any tenant without going through the
            tenant's own admin.
          </li>
          <li>
            Suspend or archive a tenant — useful for ending trials or off-boarding.
          </li>
        </Bullets>
      </DocSection>
    </DocPage>
  );
}
