import {
  DocPage,
  DocSection,
  DocSubsection,
  P,
  Bullets,
  Steps,
  Callout,
  StatusTable,
  Code,
} from "../components";

export default function PickingGuide() {
  return (
    <DocPage
      title="Mobile Picking PWA"
      intro="The Mobile Picking PWA is a tablet-and-phone-first companion app for warehouse staff. It is the same Forge ERP backend, but a focused UI that pickers can use one-handed while walking the warehouse. Supervisors get a dedicated progress board to monitor every active pick."
    >
      <DocSection title="What it is">
        <P>
          The PWA lives at <Code>/picking</Code>. It is installable to a tablet
          or phone home screen (Add to Home Screen on iOS, Install app on
          Chrome/Edge) and works full-screen without browser chrome. After
          install it runs offline-friendly: routes and the user's assigned slip
          list are cached for the current session.
        </P>
        <Callout kind="info" title="Same login, different UI">
          Pickers sign in with their normal Forge ERP credentials. The PWA
          checks the warehouse role and lands the user straight on their
          slip queue.
        </Callout>
      </DocSection>

      <DocSection title="The picker flow">
        <Steps>
          <li>
            Sign in. The home screen shows pick slips assigned to you, plus an
            <strong>Unassigned</strong> pile that anyone in the warehouse can
            grab.
          </li>
          <li>
            Tap a slip to open it. The slip lists each line in pick-route
            order (closest aisle first if the warehouse has aisle metadata).
          </li>
          <li>
            For each line, scan or tap the location, scan or tap the item, and
            confirm the quantity. Lot- or serial-tracked items prompt for the
            lot/serial.
          </li>
          <li>
            If you can't find the full quantity, tap <strong>Short pick</strong>{" "}
            and enter what you actually picked plus a reason. The shortfall
            flows back to the SO and lands on the Backorder report.
          </li>
          <li>
            When every line is confirmed, tap <strong>Complete</strong>. The
            slip closes and the SO advances toward despatch.
          </li>
        </Steps>
      </DocSection>

      <DocSection title="Pick slip statuses">
        <StatusTable
          rows={[
            { status: "Open", variant: "outline", description: "Generated, not yet started." },
            { status: "Assigned", variant: "secondary", description: "Picker assigned. Visible at the top of their queue." },
            { status: "In Progress", variant: "secondary", description: "At least one line confirmed." },
            { status: "Complete", variant: "default", description: "Every line confirmed (or short-picked). SO ready for despatch when all slips complete." },
            { status: "Cancelled", variant: "destructive", description: "Cancelled before completion. Reservations released back to the SO." },
          ]}
        />
      </DocSection>

      <DocSection title="Supervisor progress board">
        <P>
          Open the supervisor view from <strong>Sales → Pick Slips</strong> in
          the desktop app. The board shows:
        </P>
        <Bullets>
          <li>
            Every active slip with its picker, current status, and percent
            complete.
          </li>
          <li>
            Slips that have been idle for more than the configured timeout —
            useful for spotting a tablet that has been left on a forklift.
          </li>
          <li>
            Reassign action: move a slip from one picker to another without
            losing progress.
          </li>
        </Bullets>
      </DocSection>

      <DocSection title="Tips for using the PWA on a tablet">
        <Bullets>
          <li>
            <strong>Install it.</strong> The home-screen install removes the
            URL bar and prevents accidental swipes back.
          </li>
          <li>
            <strong>Use a wedge scanner if you have one.</strong> The barcode
            input fields accept any keyboard-emulating scanner.
          </li>
          <li>
            <strong>Stay signed in.</strong> Sessions are long-lived; sign-out
            is intentionally hidden behind a long-press to avoid accidental
            sign-outs mid-pick.
          </li>
        </Bullets>
        <Callout kind="warning" title="Offline limits">
          The PWA caches the current slip and route. Brand-new slips assigned
          while offline will not appear until the device regains connectivity.
        </Callout>
      </DocSection>
    </DocPage>
  );
}
