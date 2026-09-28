import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNovaClient, type AuditEntry, type AuditListRequest, type IpcResult, type PermissionRule, type Mission, type MissionDetail } from "@nova/shared";
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
import { entryFacts, filterEntries } from "./AuditSection";

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

  it("lists the rules remembered for the project and revokes one, then all after confirming", async () => {
    let rules: PermissionRule[] = [
      { id: testId(), workspaceId: "w", missionId: null, tool: null, operation: "write", pathGlob: null, host: null, decision: "allow", scope: "project", source: "user", createdAt: 2, expiresAt: null },
      { id: testId(), workspaceId: "w", missionId: null, tool: "fetch_page", operation: "network", pathGlob: null, host: "docs.example.com", decision: "allow", scope: "project", source: "user", createdAt: 1, expiresAt: null },
    ];
    const revoked: (string | null)[] = [];
    setup(<PermissionsSection />, {
      overrides: () => ({
        permissions: {
          listRules: () => ok(rules),
          revokeRules: ({ ruleId }) => {
            revoked.push(ruleId);
            const before = rules.length;
            rules = ruleId === null ? [] : rules.filter((rule) => rule.id !== ruleId);
            return ok(before - rules.length);
          },
        },
      }),
    });
    expect(await screen.findByText("docs.example.com")).toBeTruthy();
    const [first] = screen.getAllByRole("button", { name: "Révoquer" });
    await act(async () => {
      fireEvent.click(first as HTMLElement);
    });
    expect(revoked).toHaveLength(1);
    expect(await screen.findByText("docs.example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tout révoquer" }));
    expect(screen.getByText(/NOVA te redemandera/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tout révoquer" }));
    });
    expect(revoked.at(-1)).toBeNull();
    expect(await screen.findByText("Aucune autorisation mémorisée pour ce projet.")).toBeTruthy();
    // C8: the canonical exclusion list is visible.
    expect(screen.getByText(".env")).toBeTruthy();
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
  function entry(partial: Partial<AuditEntry>): AuditEntry {
    return {
      seq: 1,
      at: 1_000,
      workspaceId: null,
      missionId: null,
      toolCallId: null,
      actor: "agent",
      action: "permission.decision",
      decision: "allow",
      ruleId: null,
      target: "src/a.ts",
      dataSummary: { tool: "read_file", operation: "read" },
      costUsd: null,
      outcome: null,
      ...partial,
    };
  }

  it("shows the real audit log, sends the filters to main and filters text locally", async () => {
    const requests: AuditListRequest[] = [];
    const denied = entry({ seq: 3, decision: "deny", target: "evil.example", dataSummary: { tool: "fetch_page", operation: "network" }, outcome: "La politique Internet de ce projet refuse ce site." });
    const executed = entry({ seq: 2, action: "tool.executed", decision: null, target: "pnpm vitest", dataSummary: { tool: "run_tests", exitCode: 0, durationMs: 1200 }, outcome: "succeeded", costUsd: 0.002 });
    setup(<AuditSection />, {
      overrides: () => ({
        audit: {
          list: (req) => {
            requests.push(req);
            return ok(req.decision === "deny" ? [denied] : [denied, executed]);
          },
        },
      }),
    });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText(/code 0/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Décision" }), { target: { value: "deny" } });
    await waitFor(() => expect(requests.at(-1)).toMatchObject({ decision: "deny", limit: 200, beforeSeq: null }));
    await waitFor(() => expect(within(screen.getByRole("table")).queryByText("pnpm vitest")).toBeNull());
    expect(within(screen.getByRole("table")).getByText("evil.example")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "vitest" } });
    expect(screen.getByText("Aucune entrée ne correspond à ces filtres.")).toBeTruthy();
  });

  it("matches text on tool, target and outcome, and lists only known facts", () => {
    const rows = [entry({ seq: 1, target: "a.ts" }), entry({ seq: 2, target: null, outcome: "refusé : evil" })];
    expect(filterEntries(rows, "EVIL").map((row) => row.seq)).toEqual([2]);
    expect(filterEntries(rows, "read_file").map((row) => row.seq)).toEqual([1, 2]);
    expect(entryFacts(entry({ dataSummary: { bytesSent: 2048, exitCode: null } }))).toEqual(["2\u202f048 o envoyés"]);
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
