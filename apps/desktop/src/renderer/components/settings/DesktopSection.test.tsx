// L7 settings: the background option is explained where it is turned on and only shown once main
// serves the desktop group; the density and vision options are saved as settings.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createNovaClient, DEFAULT_SETTINGS, type DesktopEvent, type DesktopState, type IpcResult } from "@nova/shared";
import { Toaster } from "@nova/ui";
import { installDomPolyfills } from "../../test/dom";
import { createFakeBridge, type HarnessOverrides } from "../../test/fake-bridge";
import { AppProvider } from "../../state/context";
import { createAppStore } from "../../state/store";
import { DesktopSection } from "./DesktopSection";

installDomPolyfills();
afterEach(cleanup);

const STATE: DesktopState = {
  trayAvailable: false,
  keepRunningOnClose: false,
  activity: { runningMissions: 2, waitingApprovals: 1, runningTerminals: 0, runningProcesses: 1, activeSchedules: 0, nextScheduledAt: null },
};

function mount(harness: HarnessOverrides = {}) {
  const fake = createFakeBridge({ harness });
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  store.setState({ settings: DEFAULT_SETTINGS });
  render(
    <AppProvider store={store} client={client}>
      <Toaster>
        <DesktopSection />
      </Toaster>
    </AppProvider>,
  );
  return { fake, store };
}

describe("DesktopSection", () => {
  it("shows the background option with its explanation and the real activity once main serves it", async () => {
    let listener: ((event: DesktopEvent) => void) | null = null;
    const { store } = mount({
      desktop: {
        state: (): Promise<IpcResult<DesktopState>> => Promise.resolve({ ok: true, value: STATE }),
        onEvent: (next) => {
          listener = next;
          return () => undefined;
        },
      },
    });
    const option = await screen.findByRole("switch", { name: "Continuer en arrière-plan quand la fenêtre est fermée" });
    expect(screen.getByText(/Nomi reste dans la barre système/)).toBeTruthy();
    expect(screen.getByText(/barre système n'est pas disponible sur ce bureau/)).toBeTruthy();
    expect(screen.getByText("En ce moment : 2 missions en cours, 1 approbation en attente, 1 processus en arrière-plan.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(option);
    });
    expect(store.getState().settings?.desktop.keepRunningOnClose).toBe(true);
    expect(screen.getByRole("switch", { name: "Pilote automatique" })).toBeTruthy();

    // Live: the activity line follows main's events.
    act(() => listener?.({ type: "desktop.state", state: { ...STATE, activity: { ...STATE.activity, runningMissions: 0 } } }));
    expect(screen.getByText("En ce moment : 0 mission en cours, 1 approbation en attente, 1 processus en arrière-plan.")).toBeTruthy();
  });

  it("shows no background or autopilot control while main answers `unavailable`", async () => {
    const { fake } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fake.calls).toContain("desktop.state");
    expect(screen.queryByRole("switch", { name: /arrière-plan/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Pilote automatique" })).toBeNull();
    // Display-only choices still work.
    expect(screen.getByRole("radio", { name: /^Étapes clés/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Proposer un modèle qui lit les images/ })).toBeTruthy();
  });

  it("saves the density and the vision suggestion", async () => {
    const { store } = mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /^Résultat/ }));
    });
    expect(store.getState().settings?.display.density).toBe("result");
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /Proposer un modèle qui lit les images/ }));
    });
    expect(store.getState().settings?.chat.suggestVisionModel).toBe(false);
  });
});
