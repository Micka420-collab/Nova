// L7 Discuter helpers wired to a real app store and the fake bridge: the autopilot's choice is shown
// and overridable before the message leaves, it disappears while main does not serve it, and a
// pasted image with a text-only model proposes a vision model of the catalog.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNovaClient,
  DEFAULT_SETTINGS,
  type AppSettings,
  type AutopilotChoice,
  type AutopilotClassifyRequest,
  type DesktopState,
  type IpcResult,
  type ModelInfo,
} from "@nova/shared";
import { Toaster } from "@nova/ui";
import { installDomPolyfills } from "../../../test/dom";
import { createFakeBridge, makeModel, type HarnessOverrides } from "../../../test/fake-bridge";
import { AppProvider, useApp } from "../../../state/context";
import { createAppStore, selectedModelId } from "../../../state/store";
import { Composer, type ComposerProps } from "../Composer";
import { useImageAttachments } from "../vision/useImageAttachments";
import { useAutopilot } from "./useAutopilot";

installDomPolyfills();
afterEach(cleanup);

const TEXT = makeModel({ id: "acme/text", name: "Acme Text", author: "acme", inputModalities: ["text"], supportsReasoning: true });
const VISION = makeModel({
  id: "acme/vision",
  name: "Acme Vision",
  author: "acme",
  inputModalities: ["text", "image"],
  pricing: { promptPerMTok: 0.5, completionPerMTok: 1, variable: false },
});
const DESKTOP: DesktopState = {
  trayAvailable: true,
  keepRunningOnClose: false,
  activity: { runningMissions: 0, waitingApprovals: 0, runningTerminals: 0, runningProcesses: 0, activeSchedules: 0, nextScheduledAt: null },
  unreadable: [],
};
const CHOICE: AutopilotChoice = {
  reasoningEffort: "medium",
  webSearch: true,
  rationale: "Demande qui demande un peu d'analyse : effort moyen, recherche web utile.",
  classifierModelId: "acme/tiny",
  costUsd: 0.00002,
  source: "classifier",
};

const ok = <T,>(value: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, value });

function Harness({ onSend }: { onSend: ComposerProps["onSend"] }) {
  const modelId = useApp((state) => selectedModelId(state, null));
  const images = useImageAttachments(null, modelId);
  const autopilot = useAutopilot(null, modelId);
  return <Composer label="Message" streaming={false} blocked={null} onSend={onSend} onStop={() => undefined} images={images} autopilot={autopilot} />;
}

function mount(options: { chat?: Partial<AppSettings["chat"]>; harness?: HarnessOverrides; models?: ModelInfo[] } = {}) {
  const fake = createFakeBridge({ harness: options.harness ?? {} });
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  store.setState({
    settings: { ...DEFAULT_SETTINGS, defaultModelId: TEXT.id, chat: { ...DEFAULT_SETTINGS.chat, ...options.chat } },
    catalog: {
      status: "ready",
      data: { providerId: "openrouter", models: options.models ?? [TEXT, VISION], fetchedAt: 1, source: "cache", refreshError: null },
      error: null,
    },
  });
  const onSend = vi.fn<ComposerProps["onSend"]>(async () => true);
  render(
    <AppProvider store={store} client={client}>
      <Toaster>
        <Harness onSend={onSend} />
      </Toaster>
    </AppProvider>,
  );
  const input = screen.getByRole("textbox", { name: "Message" });
  const type = (text: string) => fireEvent.change(input, { target: { value: text } });
  const enter = async () => {
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
  };
  return { fake, store, onSend, input, type, enter };
}

const wired = (classify: (req: AutopilotClassifyRequest) => Promise<IpcResult<AutopilotChoice>>): HarnessOverrides => ({
  desktop: { state: () => ok(DESKTOP), onEvent: () => () => undefined },
  autopilot: { classify },
});

describe("chat autopilot", () => {
  it("shows the choice before sending; the user's override is what leaves", async () => {
    const requests: AutopilotClassifyRequest[] = [];
    const { onSend, type, enter } = mount({
      chat: { autopilot: true },
      harness: wired((req) => {
        requests.push(req);
        return ok(CHOICE);
      }),
    });
    await screen.findByText(/Pilote automatique : Entrée prépare les réglages/);
    type("  Quelles nouveautés dans Node 26 ?  ");
    await enter();
    await screen.findByText(CHOICE.rationale);
    expect(requests).toEqual([{ content: "Quelles nouveautés dans Node 26 ?", modelId: TEXT.id, hasImages: false }]);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText("Estimé par acme/tiny · coût 0,00002 $")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Élevé" }));
    fireEvent.click(screen.getByRole("switch", { name: "Recherche web" }));
    await enter();
    expect(onSend).toHaveBeenCalledWith("Quelles nouveautés dans Node 26 ?", { reasoningEffort: "high", webSearch: false });
    // Sent: the choice is gone, the next message is estimated again.
    await waitFor(() => expect(screen.queryByText(CHOICE.rationale)).toBeNull());
  });

  it("is not offered while main does not serve the desktop groups", async () => {
    const { onSend, type, enter, fake } = mount({ chat: { autopilot: true } });
    await waitFor(() => expect(fake.calls).toContain("desktop.state"));
    type("Bonjour");
    await enter();
    expect(onSend).toHaveBeenCalledWith("Bonjour");
    expect(screen.queryByText(/Pilote automatique/)).toBeNull();
  });

  it("says when main answers `unavailable`, then sends without it", async () => {
    const { onSend, type, enter } = mount({
      chat: { autopilot: true },
      harness: wired(() => Promise.resolve({ ok: false, error: { code: "unavailable", message: "not wired" } })),
    });
    await screen.findByText(/Pilote automatique : Entrée prépare les réglages/);
    type("Bonjour");
    await enter();
    expect((await screen.findByRole("alert")).textContent).toContain("n'est pas disponible");
    expect(onSend).not.toHaveBeenCalled();
    await enter();
    expect(onSend).toHaveBeenCalledWith("Bonjour");
  });

  it("stays off when the setting is off (no classifier call)", async () => {
    const classify = vi.fn<(req: AutopilotClassifyRequest) => Promise<IpcResult<AutopilotChoice>>>(() => ok(CHOICE));
    const { onSend, type, enter } = mount({ chat: { autopilot: false }, harness: wired(classify) });
    type("Bonjour");
    await enter();
    expect(onSend).toHaveBeenCalledWith("Bonjour");
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("pasted images", () => {
  const paste = async (input: HTMLElement) => {
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "capture.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(input, { clipboardData: { files: [file] } });
    });
    await screen.findByRole("img", { name: "capture.png" });
  };

  it("with a text-only model: the send waits, a vision model of the catalog is proposed, one click switches", async () => {
    const { store, input, onSend, type, enter } = mount();
    await paste(input);
    expect(screen.getByText("Acme Text ne lit pas les images.")).toBeTruthy();
    type("Que montre cette capture ?");
    await enter();
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Utiliser Acme Vision" }));
    });
    expect(selectedModelId(store.getState(), null)).toBe(VISION.id);
    await waitFor(() => expect(screen.queryByText("Acme Text ne lit pas les images.")).toBeNull());
    await enter();
    expect(onSend).toHaveBeenCalledWith("Que montre cette capture ?", {
      images: [{ mediaType: "image/png", dataBase64: "iVBORw0KGgo=", name: "capture.png" }],
    });
    // Sent once, then dropped from the composer.
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  });

  it("without a vision model in the catalog, says so and offers to remove the images", async () => {
    const { input } = mount({ models: [TEXT] });
    await paste(input);
    expect(screen.getByText(/Aucun modèle du catalogue ne lit les images/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retirer les images" }));
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  });

  it("with the suggestion turned off, blocks with the model picker only", async () => {
    const { input } = mount({ chat: { suggestVisionModel: false } });
    await paste(input);
    expect(screen.queryByRole("button", { name: /Utiliser/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Choisir un modèle" })).toBeTruthy();
  });
});
