import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNovaClient, type Approval, type IpcResult, type Mission, type MissionDetail } from "@nova/shared";
import { Toaster } from "@nova/ui";
import type { ReactNode } from "react";
import { AppProvider } from "../../state/context";
import { createAppStore } from "../../state/store";
import { createAtelierFake, makeBudget, makeContract, type AtelierFake } from "../../test/atelier-fake";
import { createFakeBridge, testId, VALID_CONNECTION, type AtelierOverrides } from "../../test/fake-bridge";
import { installDomPolyfills } from "../../test/dom";
import { AuditSection, BudgetSection, InternetSection, PermissionsSection } from "./AtelierSections";
import { costReportCsv } from "./BudgetSection";
import { hostPatternError } from "./InternetSection";
import { filterDecisions } from "./AuditSection";

installDomPolyfills();
afterEach(cleanup);

const ok = <T,>(value: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, value });

function setup(node: ReactNode, options: { withWorkspace?: boolean; overrides?: (fake: AtelierFake) => AtelierOverrides } = {}) {
  const fake = createAtelierFake();
  const extra = options.overrides?.(fake) ?? {};
  // Per-group merge: an override replaces single methods, the other fake methods stay.
  const atelier: Record<string, unknown> = { ...fake.overrides };
  for (const [group, methods] of Object.entries(extra)) {
    atelier[group] = { ...(fake.overrides as Record<string, object | undefined>)[group], ...methods };
  }
  const bridge = createFakeBridge({ connection: VALID_CONNECTION, atelier: atelier as AtelierOverrides });
  const store = createAppStore(createNovaClient(bridge.bridge));
  if (options.withWorkspace !== false) {
    store.setState((state) => ({ workspace: { ...state.workspace, current: fake.workspace } }));
  }
  render(
    <AppProvider store={store} client={createNovaClient(bridge.bridge)}>
      <Toaster>{node}</Toaster>
    </AppProvider>,
  );
  return { fake, store, calls: bridge.calls };
}

function makeApproval(partial: Partial<Omit<Approval, "request">> & { request?: Partial<Approval["request"]> } = {}): Approval {
  const { request, ...rest } = partial;
  return {
    id: testId(),
    request: { workspaceId: "w", missionId: null, tool: "run_command", operation: "execute", argv: ["pnpm", "test"], ...request },
    decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true },
    toolCallId: null,
    status: "approved",
    scope: "once",
    createdAt: 1_000,
    decidedAt: 1_100,
    ...rest,
  };
}

describe("PermissionsSection", () => {
  it("asks for a folder when none is open", () => {
    setup(<PermissionsSection />, { withWorkspace: false });
    expect(screen.getByText("Ouvre un dossier pour régler ses permissions.")).toBeTruthy();
  });

  it("saves the profile only on Enregistrer, and warns about Autonomous without isolation", async () => {
    const { calls } = setup(<PermissionsSection />);
    const autonomous = await screen.findByRole("radio", { name: /Autonome dans ce projet/ });
    const save = screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(autonomous);
    expect(screen.getByText(/Autonome sans isolation/)).toBeTruthy();
    expect(calls).not.toContain("permissions.setProfile");
    await act(async () => {
      fireEvent.click(save);
    });
    expect(calls).toContain("permissions.setProfile");
    expect((screen.getByRole("radio", { name: /Autonome dans ce projet/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("lists approvals remembered for a mission or the project, not one-time ones", async () => {
    const remembered = makeApproval({ scope: "project", request: { tool: "write_file", operation: "write", path: "src/a.ts" } });
    const once = makeApproval({ scope: "once", request: { argv: ["rm", "x"] } });
    setup(<PermissionsSection />, { overrides: () => ({ approvals: { list: () => ok([remembered, once]) } }) });
    expect(await screen.findByText("src/a.ts")).toBeTruthy();
    expect(screen.queryByText("rm x")).toBeNull();
    // No revoke API exists: no button pretends to revoke.
    expect(screen.queryByRole("button", { name: /Révoquer/ })).toBeNull();
  });

  it("says the capability is unavailable when main answers unavailable", async () => {
    setup(<PermissionsSection />, {
      overrides: () => ({
        permissions: { getProfile: () => Promise.resolve({ ok: false, error: { code: "unavailable", message: "no" } }) },
      }),
    });
    expect(await screen.findAllByText(/n'est pas disponible pour l'instant/)).toBeTruthy();
  });
});

describe("InternetSection", () => {
  it("rejects a URL as a host pattern and accepts domains and wildcards", () => {
    expect(hostPatternError("http://x")).toMatch(/n'est pas une adresse valide/);
    expect(hostPatternError("")).toBe("Adresse vide.");
    expect(hostPatternError("docs.example.com")).toBeNull();
    expect(hostPatternError("*.npmjs.org")).toBeNull();
  });

  it("does not save an invalid rule, then saves valid rules with the default action", async () => {
    const saved: unknown[] = [];
    setup(<InternetSection />, {
      overrides: (fake) => ({
        web: {
          setPolicy: (req) => {
            saved.push(req);
            return fake.overrides.web?.setPolicy?.(req) ?? ok({ workspaceId: null, defaultAction: "ask", rules: [] });
          },
        },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ajouter une règle" }));
    const pattern = screen.getByRole("textbox", { name: "Adresse de la règle 1" });
    fireEvent.change(pattern, { target: { value: "http://x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    });
    expect(saved).toEqual([]);
    expect(screen.getByText(/« http:\/\/x » n'est pas une adresse valide/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Adresse de la règle 1" }), { target: { value: "registry.npmjs.org" } });
    fireEvent.click(screen.getByRole("radio", { name: "Refuser" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    });
    expect(saved).toEqual([
      { workspaceId: null, defaultAction: "deny", rules: [{ pattern: "registry.npmjs.org", action: "allow" }], preset: null },
    ]);
  });
});

describe("AuditSection", () => {
  it("filters the recorded permission decisions by status, operation and text", async () => {
    const denied = makeApproval({ status: "denied", scope: null, createdAt: 3_000, request: { tool: "fetch_page", operation: "network", host: "evil.example" } });
    const approved = makeApproval({ createdAt: 2_000, request: { argv: ["pnpm", "vitest"] } });
    setup(<AuditSection />, { overrides: () => ({ approvals: { list: () => ok([approved, denied]) } }) });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    fireEvent.change(screen.getByRole("combobox", { name: "Statut" }), { target: { value: "denied" } });
    expect(within(screen.getByRole("table")).getByText("evil.example")).toBeTruthy();
    expect(within(screen.getByRole("table")).queryByText("pnpm vitest")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "vitest" } });
    expect(screen.getByText("Aucune décision ne correspond à ces filtres.")).toBeTruthy();
  });

  it("orders newest first", () => {
    const old = makeApproval({ createdAt: 1 });
    const recent = makeApproval({ createdAt: 2 });
    expect(filterDecisions([old, recent], { status: "all", operation: "all", text: "" }).map((a) => a.id)).toEqual([recent.id, old.id]);
  });
});

describe("BudgetSection", () => {
  function mission(partial: Partial<Mission>): Mission {
    return {
      id: testId(),
      workspaceId: "w",
      conversationId: null,
      title: "Mission",
      goal: "g",
      mode: "fix",
      state: "succeeded",
      modelId: null,
      createdAt: 1_000,
      startedAt: 1_000,
      endedAt: 2_000,
      updatedAt: 2_000,
      ...partial,
    };
  }

  it("keeps unknown costs empty in the CSV, never 0", () => {
    const known = mission({ title: 'Panier, "remise"' });
    const unknown = mission({ title: "Autre" });
    const csv = costReportCsv([
      { mission: known, budget: makeBudget({ spentUsd: 0.12, unknownCostCalls: 2 }) },
      { mission: unknown, budget: null },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("mission,etat,cout_constate_usd,appels_sans_cout,cree_le");
    expect(lines[1]).toBe(`"Panier, ""remise""",succeeded,0.12,2,${new Date(1_000).toISOString()}`);
    expect(lines[2]).toBe(`Autre,succeeded,,,${new Date(1_000).toISOString()}`);
  });

  it("reports each mission's observed cost with 'au moins' and copies the CSV", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const { fake } = setup(<BudgetSection />, {
      overrides: (atelier) => {
        const item = mission({ workspaceId: atelier.workspace.id, title: "Corriger le panier" });
        const detail: MissionDetail = {
          mission: item,
          contract: makeContract(atelier.workspace.id),
          tasks: [],
          proofs: [],
          budget: makeBudget({ spentUsd: 0.42, unknownCostCalls: 1, dailySpentUsd: 1.2 }),
          events: [],
        };
        return { missions: { ...atelier.overrides.missions, list: () => ok({ items: [item], hasMore: false }), get: () => ok(detail) } };
      },
    });
    expect(fake.workspace).toBeTruthy();
    expect(await screen.findByText(/au moins 0,42 \$ \(1 appel sans coût rapporté\)/)).toBeTruthy();
    expect(screen.getByRole("meter")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copier en CSV" }));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Corriger le panier,succeeded,0.42,1,"));
    expect(await screen.findByText("Copié")).toBeTruthy();
  });

  it("without a folder, shows the defaults and says where the cost report lives", () => {
    setup(<BudgetSection />, { withWorkspace: false });
    expect(screen.getByText("Plafond par mission")).toBeTruthy();
    expect(screen.getByText("Ouvre un dossier pour voir le coût de ses missions.")).toBeTruthy();
    expect(screen.getByText(/montant final chez OpenRouter peut différer/)).toBeTruthy();
  });
});
