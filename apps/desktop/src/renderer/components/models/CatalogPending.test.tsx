// A catalog that is loading or failed to load is unknown: the schedule form and the mission's model
// switcher say so (with a retry), never « no model ».
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createNovaClient, DEFAULT_SETTINGS } from "@nova/shared";
import { installDomPolyfills } from "../../test/dom";
import { createFakeBridge } from "../../test/fake-bridge";
import { AppProvider } from "../../state/context";
import { createAppStore } from "../../state/store";
import { ModelSwitcher } from "../context/ModelSwitcher";
import { ScheduleEditor } from "../schedules/ScheduleEditor";

installDomPolyfills();
afterEach(cleanup);

function mount(status: "loading" | "error", ui: React.ReactNode) {
  const fake = createFakeBridge();
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  store.setState({
    settings: DEFAULT_SETTINGS,
    catalog: { status, data: null, error: status === "error" ? { code: "internal", providerError: null } : null },
  });
  render(
    <AppProvider store={store} client={client}>
      {ui}
    </AppProvider>,
  );
  return { fake, store };
}

const editor = <ScheduleEditor schedule={null} models={null} defaultModelId={null} save={async () => undefined} onCancel={() => undefined} />;

describe("catalog not loaded", () => {
  it("the schedule form says the catalog is loading, not that no model has tools", () => {
    mount("loading", editor);
    expect(screen.getByText("Chargement du catalogue…")).toBeTruthy();
    expect(screen.queryByText("Aucun modèle avec outils dans le catalogue.")).toBeNull();
  });

  it("a failed catalog is said so, with a retry that asks main again", async () => {
    const { fake } = mount("error", editor);
    expect(screen.getByText(/Le catalogue n'a pas pu être chargé/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    });
    expect(fake.calls).toContain("models.catalog");
  });

  it("the model switcher of a mission never says no other model accepts tools", () => {
    mount("loading", <ModelSwitcher models={null} currentModelId="vendor/a" onSwitch={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Changer de modèle/ }));
    expect(screen.getByText("Chargement du catalogue…")).toBeTruthy();
    expect(screen.queryByText("Aucun autre modèle du catalogue n’accepte les outils.")).toBeNull();
  });
});
