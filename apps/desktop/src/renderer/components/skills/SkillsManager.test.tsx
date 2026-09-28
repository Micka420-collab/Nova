import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNovaClient,
  type IpcResult,
  type NovaBridge,
  type SkillMeta,
  type SkillPreview,
  type SkillRef,
  type SkillSetEnabledRequest,
} from "@nova/shared";
import { Toaster } from "@nova/ui";
import { AppProvider } from "../../state/context";
import { createAppStore } from "../../state/store";
import { makeWorkspace } from "../../test/atelier-fake";
import { installDomPolyfills } from "../../test/dom";
import { createFakeBridge, VALID_CONNECTION } from "../../test/fake-bridge";
import { SkillsManager } from "./SkillsManager";

installDomPolyfills();
afterEach(cleanup);

const ok = <T,>(value: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, value });
const fail = (code: "invalid_request" | "conflict" | "unavailable", message: string): Promise<IpcResult<never>> =>
  Promise.resolve({ ok: false, error: { code, message } });

function meta(ref: SkillRef, partial: Partial<SkillMeta> = {}): SkillMeta {
  const [scope, name] = ref.split(":") as [SkillMeta["scope"], string];
  return {
    ref,
    name,
    description: `Description de ${name}.`,
    version: null,
    scope,
    workspaceId: null,
    enabled: false,
    declared: { tools: [], hosts: [], scripts: [] },
    contentHash: "h1",
    fileCount: 1,
    totalBytes: 100,
    installedAt: scope === "user" ? 1 : null,
    ...partial,
  };
}

function preview(skill: SkillMeta, partial: Partial<SkillPreview> = {}): SkillPreview {
  return {
    meta: skill,
    content: "# Étapes\nLire le README.",
    files: [
      { path: "SKILL.md", size: 80, kind: "skill_md" },
      { path: "scripts/check.sh", size: 20, kind: "script" },
    ],
    warnings: [{ code: "has_scripts", subject: null }],
    previewId: "00000000-0000-4000-8000-0000000000f1",
    replaces: null,
    ...partial,
  };
}

/** In-memory skills.* group with main's semantics (enable, install, uninstall). */
function inMemorySkills(initial: SkillMeta[]) {
  const skills = new Map(initial.map((skill) => [skill.ref, skill]));
  const enables: SkillSetEnabledRequest[] = [];
  const calls: string[] = [];
  let nextPreview: Promise<IpcResult<SkillPreview | null>> = ok(null);
  const group: Partial<NovaBridge["skills"]> = {
    list: () => ok([...skills.values()]),
    get: ({ ref }) => {
      const skill = skills.get(ref);
      return skill ? ok({ meta: skill, content: `# ${skill.name}\nContenu.`, files: [], warnings: [] }) : fail("invalid_request", "nope");
    },
    preview: (req) => {
      calls.push(`preview:${req.source.kind}`);
      return nextPreview;
    },
    install: ({ previewId }) => {
      calls.push(`install:${previewId}`);
      const installed = meta("user:pdf-outils", { fileCount: 2 });
      skills.set(installed.ref, installed);
      return ok(installed);
    },
    uninstall: ({ ref }) => {
      calls.push(`uninstall:${ref}`);
      skills.delete(ref);
      return ok(undefined);
    },
    setEnabled: (req) => {
      enables.push(req);
      const skill = skills.get(req.ref);
      if (!skill) return fail("invalid_request", "nope");
      const updated = { ...skill, enabled: req.enabled };
      skills.set(req.ref, updated);
      return ok(updated);
    },
  };
  return { group, enables, calls, setNextPreview: (next: Promise<IpcResult<SkillPreview | null>>) => (nextPreview = next) };
}

function renderManager(group: Partial<NovaBridge["skills"]> | null, withWorkspace = true) {
  const fake = createFakeBridge({ connection: VALID_CONNECTION, ...(group ? { harness: { skills: group } } : {}) });
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  const workspace = makeWorkspace();
  if (withWorkspace) store.setState((state) => ({ workspace: { ...state.workspace, current: workspace } }));
  render(
    <AppProvider store={store} client={client}>
      <Toaster>
        <SkillsManager />
      </Toaster>
    </AppProvider>,
  );
  return { ...fake, workspace };
}

const BUILTIN = meta("builtin:comprendre-un-depot");

describe("SkillsManager", () => {
  it("shows no control at all while main has no skills service", async () => {
    renderManager(null);
    expect(await screen.findByText("Les skills ne sont pas disponibles pour l'instant.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Installer depuis un dossier…" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("lists shipped skills under their French name and enables one for the open project", async () => {
    const memory = inMemorySkills([BUILTIN]);
    const { workspace } = renderManager(memory.group);
    const row = await screen.findByRole("listitem", { name: "Comprendre un dépôt" });
    expect(within(row).getByText("Livrée avec NOVA")).toBeTruthy();
    expect(screen.getByText("Aucune skill installée.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row).getByRole("switch", { name: `Activer pour ${workspace.name}` }));
    });
    expect(memory.enables).toEqual([{ workspaceId: workspace.id, ref: "builtin:comprendre-un-depot", enabled: true }]);
    expect(within(row).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("« Comprendre un dépôt » activée pour ce projet")).toBeTruthy();
  });

  it("without a project, offers no activation", async () => {
    renderManager(inMemorySkills([BUILTIN]).group, false);
    await screen.findByRole("listitem", { name: "Comprendre un dépôt" });
    expect(screen.getByText("Ouvre un projet pour activer une skill.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the content, declared permissions and warnings BEFORE installing", async () => {
    const memory = inMemorySkills([BUILTIN]);
    renderManager(memory.group);
    const skill = meta("user:pdf-outils", { declared: { tools: ["read_file", "Bash"], hosts: ["api.example.com"], scripts: ["scripts/check.sh"] } });
    memory.setNextPreview(ok(preview(skill, { warnings: [{ code: "has_scripts", subject: null }, { code: "unknown_tool", subject: "Bash" }] })));
    const install = await screen.findByRole("button", { name: "Installer depuis un dossier…" });
    await act(async () => {
      fireEvent.click(install);
    });
    const dialog = screen.getByRole("dialog", { name: "Aperçu avant installation" });
    expect(within(dialog).getByText(/Lire le README\./)).toBeTruthy();
    expect(within(dialog).getByText("api.example.com")).toBeTruthy();
    expect(within(dialog).getByText(/n'accordent aucun droit/)).toBeTruthy();
    expect(within(dialog).getByText("Outil demandé inconnu de NOVA : Bash (ignoré).")).toBeTruthy();
    expect(memory.calls).toEqual(["preview:picker"]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Installer" }));
    });
    expect(memory.calls).toEqual(["preview:picker", "install:00000000-0000-4000-8000-0000000000f1"]);
    expect(screen.queryByRole("dialog", { name: "Aperçu avant installation" })).toBeNull();
    expect(await screen.findByRole("listitem", { name: "pdf-outils" })).toBeTruthy();
    expect(screen.getByText("Skill « pdf-outils » installée · 2 fichiers")).toBeTruthy();
  });

  it("closes quietly when the folder picker is cancelled, and explains an invalid folder", async () => {
    const memory = inMemorySkills([BUILTIN]);
    renderManager(memory.group);
    const install = await screen.findByRole("button", { name: "Installer depuis un dossier…" });
    await act(async () => {
      fireEvent.click(install);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    memory.setNextPreview(fail("invalid_request", "skill_invalid:missing_skill_md"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Installer depuis un dossier…" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Aperçu avant installation" });
    expect(within(dialog).getByText("Paquet invalide : SKILL.md manquant.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Installer" })).toBeNull();
  });

  it("never enables a project skill without showing its content first", async () => {
    const project = meta("project:deploiement", { workspaceId: "w" });
    const memory = inMemorySkills([BUILTIN, project]);
    renderManager(memory.group);
    memory.setNextPreview(ok(preview(project)));
    const row = await screen.findByRole("listitem", { name: "deploiement" });
    await act(async () => {
      fireEvent.click(within(row).getByRole("switch"));
    });
    expect(memory.enables).toEqual([]);
    const dialog = screen.getByRole("dialog", { name: "Aperçu avant activation" });
    expect(within(dialog).getByText(/Lire le README\./)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Activer pour ce projet" }));
    });
    expect(memory.enables.map((req) => [req.ref, req.enabled])).toEqual([["project:deploiement", true]]);
    expect(within(row).getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("uninstalls after confirmation, and the skill leaves the list", async () => {
    const memory = inMemorySkills([BUILTIN, meta("user:notes")]);
    renderManager(memory.group);
    const row = await screen.findByRole("listitem", { name: "notes" });
    fireEvent.click(within(row).getByRole("button", { name: "Désinstaller" }));
    const confirm = screen.getByRole("dialog", { name: "Désinstaller « notes » ?" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Désinstaller" }));
    });
    expect(memory.calls).toEqual(["uninstall:user:notes"]);
    expect(screen.queryByRole("listitem", { name: "notes" })).toBeNull();
    expect(screen.getByText("« notes » désinstallée")).toBeTruthy();
  });
});
