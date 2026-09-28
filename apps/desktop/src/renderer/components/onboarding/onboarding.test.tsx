// L7 first-run choices and density controls: the profile question comes after the key, is saved
// with the density, and the mission card switch changes what is shown (never the mission).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createNovaClient, DEFAULT_SETTINGS, type AppSettings, type ProviderConnectionView } from "@nova/shared";
import { Toaster } from "@nova/ui";
import { installDomPolyfills } from "../../test/dom";
import { ABSENT_CONNECTION, createFakeBridge, VALID_CONNECTION } from "../../test/fake-bridge";
import { AppProvider } from "../../state/context";
import { createAppStore } from "../../state/store";
import type { TimelineItem } from "../missions/timeline";
import { MissionDensityBar, useMissionDensity } from "./DensityChoice";
import { needsProfileOnboarding, ProfileOnboardingGate } from "./ProfileOnboarding";

installDomPolyfills();
afterEach(cleanup);

/** First run answers the key and the model before this question (defaultModelId set). */
const MODEL_CHOSEN: Partial<AppSettings> = { defaultModelId: "acme/model" };

function mount(node: React.ReactNode, settings: Partial<AppSettings> = MODEL_CHOSEN, connection: ProviderConnectionView = VALID_CONNECTION) {
  const fake = createFakeBridge({ settings, connection });
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  store.setState({ settings: { ...DEFAULT_SETTINGS, ...settings }, connection });
  render(
    <AppProvider store={store} client={client}>
      <Toaster>{node}</Toaster>
    </AppProvider>,
  );
  return { fake, store };
}

describe("needsProfileOnboarding", () => {
  it("is due once a key exists and until a profile is saved", () => {
    expect(needsProfileOnboarding(DEFAULT_SETTINGS, VALID_CONNECTION)).toBe(true);
    expect(needsProfileOnboarding(DEFAULT_SETTINGS, ABSENT_CONNECTION)).toBe(false);
    expect(needsProfileOnboarding(DEFAULT_SETTINGS, null)).toBe(false);
    expect(needsProfileOnboarding({ ...DEFAULT_SETTINGS, onboarding: { profile: "code", completedAt: 1 } }, VALID_CONNECTION)).toBe(false);
    expect(needsProfileOnboarding(null, VALID_CONNECTION)).toBe(false);
  });
});

describe("ProfileOnboardingGate", () => {
  it("asks for a profile, proposes its density, and saves both", async () => {
    const { store, fake } = mount(<ProfileOnboardingGate />);
    expect(screen.getByRole("dialog", { name: "Comment vas-tu utiliser NOVA ?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Commencer" }));
    expect(screen.getByRole("alert").textContent).toBe("Choisis ton usage principal pour continuer.");
    expect(fake.calls).not.toContain("settings.update");

    fireEvent.click(screen.getByRole("radio", { name: /Documents et création/ }));
    expect((screen.getByRole("radio", { name: /^Résultat/ }) as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Commencer" }));
    });
    const saved = store.getState().settings;
    expect(saved?.onboarding.profile).toBe("documents");
    expect(saved?.onboarding.completedAt).toBeGreaterThan(0);
    expect(saved?.display.density).toBe("result");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps a density the user picked over the one the profile proposes", async () => {
    const { store } = mount(<ProfileOnboardingGate />);
    fireEvent.click(screen.getByRole("radio", { name: /^Tout/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Code et développement/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Commencer" }));
    });
    expect(store.getState().settings?.display.density).toBe("all");
    expect(store.getState().settings?.onboarding.profile).toBe("code");
  });

  it("« Plus tard » closes it for this session without saving anything", () => {
    const { fake } = mount(<ProfileOnboardingGate />);
    fireEvent.click(screen.getAllByRole("button", { name: "Plus tard" })[0] as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.calls).not.toContain("settings.update");
  });

  it("waits for the model to be chosen (one first-run question at a time)", () => {
    mount(<ProfileOnboardingGate />, {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not shown before the key step", () => {
    mount(<ProfileOnboardingGate />, {}, ABSENT_CONNECTION);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

function Card({ items }: { items: TimelineItem[] }) {
  const density = useMissionDensity(items);
  return (
    <>
      <MissionDensityBar control={density} />
      <ul>
        {density.items.map((item) => (
          <li key={item.id}>{item.id}</li>
        ))}
      </ul>
    </>
  );
}

describe("MissionDensityBar", () => {
  const read = (id: string): TimelineItem => ({
    kind: "tool", id, seq: 1, at: 1, taskId: null, permission: null, approvalId: null, state: "succeeded", isolationLevel: null,
    display: null, durationMs: 1, output: "", call: { id, name: "read_file", operation: "read", argumentsPreview: "{}", path: null, host: null, argv: null },
  });
  const answer: TimelineItem = { kind: "message", id: "answer", seq: 2, at: 2, text: "Fait.", complete: true, usage: null };

  it("says what the density hides and « Tout afficher » saves the « Tout » density", async () => {
    const { store } = mount(<Card items={[read("r1"), read("r2"), answer]} />, { display: { density: "key_steps" } });
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["answer"]);
    expect(screen.getByText("2 étapes masquées (niveau « Étapes clés »)")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tout afficher" }));
    });
    expect(store.getState().settings?.display.density).toBe("all");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText(/masquée/)).toBeNull();
  });
});
