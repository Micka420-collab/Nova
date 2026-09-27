// Renders the whole renderer app on the in-memory bridge, as App.test does.
import { render } from "@testing-library/react";
import { createNovaClient } from "@nova/shared";
import { Toaster } from "@nova/ui";
import { App } from "../App";
import { AppProvider } from "../state/context";
import { createAppStore } from "../state/store";
import { createFakeBridge, type FakeSeed } from "./fake-bridge";

export function renderApp(seed: FakeSeed) {
  const fake = createFakeBridge(seed);
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  render(
    <AppProvider store={store} client={client}>
      <Toaster>
        <App />
      </Toaster>
    </AppProvider>,
  );
  return { ...fake, store };
}
