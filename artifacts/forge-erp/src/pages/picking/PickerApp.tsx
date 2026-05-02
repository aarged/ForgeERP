/**
 * Top-level component for the /picking route. Handles its own nested
 * Switch (queue, slip detail) and registers the service worker on mount.
 */
import { useEffect } from "react";
import { Route, Switch } from "wouter";
import { Show } from "@clerk/react";
import { Redirect } from "wouter";
import PickerHomePage from "./PickerHomePage";
import PickerSlipPage from "./PickerSlipPage";
import { registerPickerServiceWorker } from "./lib/registerSW";

export default function PickerApp() {
  useEffect(() => {
    registerPickerServiceWorker();
  }, []);

  return (
    <>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
      <Show when="signed-in">
        <Switch>
          <Route path="/picking" component={PickerHomePage} />
          <Route path="/picking/slip/:id" component={PickerSlipPage} />
        </Switch>
      </Show>
    </>
  );
}
