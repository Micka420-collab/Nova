import { MISSION_ID, MissionLog } from "@nova/companion/testing";
import { createNovaClient, type CompanionSuggestion, type Mission, type MissionDetail } from "@nova/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppProvider } from "../../state/context";
import { createCompanionStore, type CompanionClient, type CompanionStore } from "../../state/companion-slice";
import { createAppStore, type AppStore } from "../../state/store";
import { installDomPolyfills } from "../../test/dom";
import { VALID_CONNECTION, createFakeBridge } from "../../test/fake-bridge";
import { NomiDock } from "../layout/NomiDock";
import { CompanionProvider } from "./CompanionContext";

installDomPolyfills();
afterEach(cleanup);

const mission = (state: Mission["state"]): Mission => ({
  id: MISSION_ID,
  workspaceId: "w",
  conversationId: null,
  title: "Facturation",
  goal: "g",
  mode: "fix",
  state,
  modelId: null,
  createdAt: 1,
  startedAt: 1,
  endedAt: null,
  updatedAt: 1,
});

function setup({ withCompanion = true } = {}) {
  const fake = createFakeBridge({ connection: VALID_CONNECTION });
  const client = createNovaClient(fake.bridge);
  const appStore: AppStore = createAppStore(client);
  appStore.setState({ connection: VALID_CONNECTION });
  const log = new MissionLog().created("Facturation").started();
  const calls: string[] = [];
  const companionClient = {
    companion: {
      state: async () => ({ suggestion: null, signals: [] }),
      act: async () => {
        calls.push("companion.act");
        return { suggestion: null, performedByMain: false, navigate: null };
      },
      onEvent: () => () => {},
    },
    missions: {
      get: async () => ({ mission: mission("running"), events: log.events }) as unknown as MissionDetail,
      stop: async () => {
        calls.push("missions.stop");
        return mission("cancelled");
      },
      resume: async () => mission("running"),
      list: async () => ({ items: [], hasMore: false }),
      onEvent: () => () => {},
    },
    approvals: { list: async () => [] },
  } as unknown as CompanionClient;
  const companion: CompanionStore = createCompanionStore({
    client: companionClient,
    navigate: (action) => appStore.getState().navigateCompanion(action),
    openSettings: () => appStore.getState().openSettings("companion"),
  });
  const dock = <NomiDock />;
  render(
    <AppProvider store={appStore} client={client}>
      {withCompanion ? <CompanionProvider store={companion}>{dock}</CompanionProvider> : dock}
    </AppProvider>,
  );
  return { appStore, companion, calls, log, fake };
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve)));

describe("NomiDock", () => {
  it("without the companion store keeps the J1 behavior: a click opens the companion settings", () => {
    const { appStore } = setup({ withCompanion: false });
    const button = screen.getByTitle("Ouvrir les réglages du compagnon");
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(button);
    expect(appStore.getState().ui.route).toBe("settings");
  });

  it("a click opens the quick-actions menu with only the entries backed by a fact", () => {
    setup();
    fireEvent.click(screen.getByTitle("Actions de Nomi"));
    const menu = screen.getByRole("menu", { name: "Actions de Nomi" });
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Mode discret pendant 1 h", "Réglages du compagnon"]);
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTitle("Actions de Nomi"));
  });

  it("a running edit shows the tool accessory and offers to stop; stopping ends in a visible outcome", async () => {
    const { companion, log, calls } = setup();
    log.tool("c1", "edit_file");
    act(() => {
      for (const event of log.events) companion.getState().applyMissionEvent(event);
    });
    const figure = document.querySelector(".nv-nomi");
    expect(figure?.getAttribute("data-state")).toBe("working");
    expect(figure?.querySelector("[data-accessory='tool']")).not.toBeNull();
    expect(screen.getByText("Facturation")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Actions de Nomi"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Arrêter la mission" }));
    });
    await flush();
    expect(calls).toEqual(["missions.stop"]);
    expect(within(screen.getByRole("status", { name: "Messages de Nomi" })).getByText("« Facturation » est arrêtée.")).toBeTruthy();
  });

  it("shows the visible suggestion with its evidence and the three answers", async () => {
    const { companion, calls } = setup();
    const suggestion: CompanionSuggestion = {
      id: "sug-1",
      signalId: "sig-1",
      text: "La commande pnpm build s'est arrêtée (code 2).",
      action: { type: "explain_error", sourceRef: { kind: "terminal", sessionId: "s" } },
      status: "proposed",
      createdAt: 1,
    };
    act(() => {
      companion.getState().applyCompanionEvent({
        type: "signal",
        signal: {
          id: "sig-1",
          kind: "process_crashed",
          workspaceId: null,
          sourceRef: { kind: "terminal", sessionId: "s" },
          evidence: { excerpt: "error TS2345", path: null },
          state: "new",
          createdAt: 1,
        },
      });
      companion.getState().applyCompanionEvent({ type: "suggestion", suggestion });
    });
    const region = screen.getByRole("status", { name: "Messages de Nomi" });
    expect(within(region).getByText(suggestion.text)).toBeTruthy();
    expect(within(region).getByText("error TS2345")).toBeTruthy();
    for (const name of ["Regarde", "Plus tard", "Ignore ce type de signal"]) within(region).getByRole("button", { name });
    await act(async () => {
      fireEvent.click(within(region).getByRole("button", { name: "Plus tard" }));
    });
    expect(calls).toEqual(["companion.act"]);
    expect(within(region).getByText("D'accord, je la garde pour plus tard.")).toBeTruthy();
  });

  it("explains a failed answer locally, with the cost of asking the model shown before sending", async () => {
    const { appStore, fake } = setup();
    act(() => {
      appStore.setState({
        lastOutcome: {
          kind: "error",
          at: Date.now(),
          conversationId: "c1",
          error: { code: "timeout", httpStatus: null, retryAfterSec: null, providerMessage: null, retryable: true },
        },
        settings: { ...appStore.getState().settings!, defaultModelId: "vendor/model-a" },
      });
    });
    fireEvent.click(screen.getByTitle("Actions de Nomi"));
    const before = fake.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Explique cette erreur" }));
    });
    const region = screen.getByRole("status", { name: "Messages de Nomi" });
    expect(within(region).getByText("Ce qui s'est passé")).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Demander au modèle" })).toBeTruthy();
    expect(within(region).getByText(/^Coût estimé : /)).toBeTruthy();
    // Level 1 is local: no call reached main.
    expect(fake.calls.slice(before)).toEqual([]);
  });

  it("« Demander au modèle » confirms only once the question was sent, else says why, and shows the new conversation", async () => {
    const { appStore, fake } = setup();
    const explain = async () => {
      act(() => {
        appStore.setState({
          lastOutcome: {
            kind: "error",
            at: Date.now(),
            conversationId: "c1",
            error: { code: "timeout", httpStatus: null, retryAfterSec: null, providerMessage: null, retryable: true },
          },
          settings: { ...appStore.getState().settings!, defaultModelId: "vendor/model-a" },
        });
      });
      fireEvent.click(screen.getByTitle("Actions de Nomi"));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Explique cette erreur" }));
      });
      return screen.getByRole("status", { name: "Messages de Nomi" });
    };

    fake.failNext("chat.send", { code: "unavailable", message: "offline" });
    let region = await explain();
    await act(async () => {
      fireEvent.click(within(region).getByRole("button", { name: "Demander au modèle" }));
    });
    expect(within(region).queryByText(/Question envoyée/)).toBeNull();
    expect(within(region).getByText(/^L'action n'a pas abouti : /)).toBeTruthy();

    region = await explain();
    await act(async () => {
      fireEvent.click(within(region).getByRole("button", { name: "Demander au modèle" }));
    });
    expect(within(region).getByText(/Question envoyée/)).toBeTruthy();
    expect(appStore.getState().activeId).not.toBeNull();
    expect(appStore.getState().ui.route).toBe("chat");
  });

  it("a failed answer in a conversation not on screen is a P6 fact: open it, or close the fact for good", async () => {
    const { appStore } = setup();
    act(() => {
      appStore.setState({
        lastOutcome: {
          kind: "error",
          at: Date.now(),
          conversationId: "c1",
          error: { code: "timeout", httpStatus: null, retryAfterSec: null, providerMessage: null, retryable: true },
        },
      });
    });
    const region = screen.getByRole("status", { name: "Messages de Nomi" });
    expect(within(region).getByText("La dernière réponse a échoué (délai dépassé).")).toBeTruthy();
    act(() => {
      fireEvent.click(within(region).getByRole("button", { name: "Voir la conversation" }));
    });
    expect(appStore.getState().activeId).toBe("c1");
    expect(appStore.getState().ui.route).toBe("chat");
    // On screen now: the conversation shows its own error, Nomi stays silent.
    expect(within(region).queryByText("La dernière réponse a échoué (délai dépassé).")).toBeNull();
    act(() => {
      appStore.getState().goHome();
    });
    act(() => {
      fireEvent.click(within(region).getByRole("button", { name: "Fermer" }));
    });
    expect(region.textContent).toBe("");
  });

  it("announces terminal transitions only (success, error, waiting), never a working pose", () => {
    const { appStore } = setup();
    const announce = () => document.querySelector(".nova-nomi-announce")?.textContent ?? null;
    expect(announce()).toBe("");
    act(() => {
      appStore.setState({ lastOutcome: { kind: "success", at: Date.now(), conversationId: "c1", error: null } });
    });
    expect(announce()).toMatch(/^Réponse terminée · /);
  });
});
