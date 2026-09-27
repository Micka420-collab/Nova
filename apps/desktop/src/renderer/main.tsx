import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createNovaClient } from "@nova/shared";
import { Toaster } from "@nova/ui";
// oxlint-disable-next-line import/no-unassigned-import -- design system stylesheet, emitted as a CSS file
import "@nova/ui/styles.css";
// oxlint-disable-next-line import/no-unassigned-import -- workshop layout stylesheet, emitted as a CSS file
import "./styles/app.css";
import { App } from "./App";
import { AppProvider } from "./state/context";
import { createAppStore } from "./state/store";

const client = createNovaClient(window.novaBridge);
const store = createAppStore(client);
const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <AppProvider store={store} client={client}>
      <Toaster>
        <App />
      </Toaster>
    </AppProvider>
  </StrictMode>,
);
