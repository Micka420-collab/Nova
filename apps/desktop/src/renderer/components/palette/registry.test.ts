import { describe, expect, it, vi } from "vitest";
import { createNovaClient, type Approval } from "@nova/shared";
import type { ToastApi } from "@nova/ui";
import { createAppStore, type AppStore } from "../../state/store";
import { createFakeBridge, makeConversation, VALID_CONNECTION } from "../../test/fake-bridge";
import { makeWorkspace } from "../../test/atelier-fake";
import { missionWithEdits } from "../diff/test-helpers";
import {
  buildCommands,
  commandForEvent,
  paletteCommands,
  runCommand,
  shortcutId,
  type CommandContext,
  type CommandDefinition,
  type KeyEventLike,
} from "./registry";
import { parsePaletteInput } from "./CommandPalette";

const COMMANDS = buildCommands();

function key(partial: Partial<KeyEventLike> & Pick<KeyEventLike, "key">): KeyEventLike {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...partial };
}

function emptyStore(): AppStore {
  return createAppStore(createNovaClient(createFakeBridge({ connection: VALID_CONNECTION }).bridge));
}

/** A state where every contextual command applies: folder, running mission, approval, stream. */
function richStore(missionState: "running" | "suspended" = "running"): AppStore {
  const store = emptyStore();
  const workspace = makeWorkspace();
  const view = missionWithEdits(workspace.id, [{ path: "src/a.ts", change: "modified", additions: 1, deletions: 0 }]);
  const running = { ...view, mission: { ...view.mission, state: missionState } };
  const conversation = makeConversation();
  const approval: Approval = {
    id: "approval-1",
    request: { workspaceId: workspace.id, missionId: view.mission.id, tool: "run_command", operation: "execute", argv: ["ls"] },
    decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "Règle de test." },
    toolCallId: null,
    status: "pending",
    scope: null,
    createdAt: 1,
    decidedAt: null,
  };
  store.setState((state) => ({
    workspace: { ...state.workspace, current: workspace, status: "ready" },
    missions: { ...state.missions, views: { [view.mission.id]: running }, selectedId: view.mission.id },
    approvals: { [approval.id]: approval },
    activeId: conversation.id,
    streams: { [conversation.id]: { streamId: "s-1", messageId: "m-1", phase: "writing", draft: "", fromStart: true } },
    ui: { ...state.ui, route: "chat" },
  }));
  return store;
}

function ctx(store: AppStore, focus: CommandContext["focus"] = "other"): CommandContext {
  return { state: store.getState(), focus };
}

describe("command registry", () => {
  it("has unique `category.action` ids with a French title", () => {
    const ids = new Set<string>();
    for (const command of COMMANDS) {
      expect(command.id).toMatch(/^[a-z]+\.[A-Za-z.]+$/);
      expect(command.id.split(".")[0]).toBe(command.category);
      expect(command.title.trim().length).toBeGreaterThan(0);
      expect(ids.has(command.id)).toBe(false);
      ids.add(command.id);
    }
  });

  it("binds each shortcut to one command only, and never Ctrl+Alt (AltGr on AZERTY)", () => {
    const seen = new Map<string, string>();
    for (const command of COMMANDS) {
      for (const shortcut of command.keys ?? []) {
        expect(shortcut.mod && shortcut.alt).toBeFalsy();
        const id = shortcutId(shortcut);
        expect(seen.get(id), `${id} is bound to ${seen.get(id)} and ${command.id}`).toBeUndefined();
        seen.set(id, command.id);
      }
    }
  });

  it("makes every command reachable: in the palette in some context, or by its keys", () => {
    const contexts = [ctx(emptyStore()), ctx(richStore()), ctx(richStore("suspended"))];
    const inPalette = new Set(contexts.flatMap((context) => paletteCommands(COMMANDS, context).map(({ command }) => command.id)));
    const unreachable = COMMANDS.filter(
      (command: CommandDefinition) => !inPalette.has(command.id) && !(command.palette === false && (command.keys?.length ?? 0) > 0),
    ).map((command) => command.id);
    expect(unreachable).toEqual([]);
  });

  it("hides mission commands without a folder and shows unavailable ones with their reason", () => {
    const empty = paletteCommands(COMMANDS, ctx(emptyStore()));
    const ids = empty.map(({ command }) => command.id);
    expect(ids).not.toContain("mission.pause");
    expect(ids).not.toContain("mission.mode.fix");
    expect(ids).toContain("mission.mode.discuss");
    expect(empty.find(({ command }) => command.id === "settings.permissions")?.availability).toEqual({
      ok: false,
      reason: "Ouvre d'abord un dossier.",
    });
  });

  it("resolves keys by context: the editor and terminal keep theirs except global commands", () => {
    const store = richStore();
    expect(commandForEvent(COMMANDS, key({ key: "D", ctrlKey: true, shiftKey: true }), ctx(store))?.id).toBe("layout.toggleMode");
    expect(commandForEvent(COMMANDS, key({ key: "b", ctrlKey: true }), ctx(store, "editor"))).toBeNull();
    expect(commandForEvent(COMMANDS, key({ key: "j", metaKey: true }), ctx(store, "terminal"))?.id).toBe("layout.toggleDock");
    expect(commandForEvent(COMMANDS, key({ key: "F6" }), ctx(store, "terminal"))?.id).toBe("focus.nextZone");
    expect(commandForEvent(COMMANDS, key({ key: "a", ctrlKey: true, shiftKey: true }), ctx(store, "editor"))?.id).toBe("approval.focus");
    // AltGr (Ctrl+Alt) never triggers a NOVA shortcut; nor does an IME composition.
    expect(commandForEvent(COMMANDS, key({ key: "b", ctrlKey: true, altKey: true }), ctx(store))).toBeNull();
    expect(commandForEvent(COMMANDS, { ...key({ key: "b", ctrlKey: true }), isComposing: true }, ctx(store))).toBeNull();
    // Without a pending approval, Ctrl+Maj+A does nothing rather than failing.
    expect(commandForEvent(COMMANDS, key({ key: "a", ctrlKey: true, shiftKey: true }), ctx(emptyStore()))).toBeNull();
  });

  it("never throws to its caller: failures become a toast", async () => {
    const store = richStore();
    const shown: string[] = [];
    const toast: ToastApi = {
      show: vi.fn<ToastApi["show"]>((options) => {
        shown.push(options.title);
        return String(shown.length);
      }),
      dismiss: vi.fn<ToastApi["dismiss"]>(),
    };
    for (const { command, availability } of paletteCommands(COMMANDS, ctx(store))) {
      if (!availability.ok) continue;
      await expect(runCommand(command, ctx(store), { store, toast })).resolves.toBeUndefined();
    }
    // `file.openFolder` hits a bridge without the workspace group: the failure is shown, not thrown.
    expect(shown.length).toBeGreaterThan(0);
  });

  it("reads the palette prefixes", () => {
    expect(parsePaletteInput("> thème")).toEqual({ kind: "commands", query: "thème" });
    expect(parsePaletteInput("@src/app")).toEqual({ kind: "files", query: "src/app" });
    expect(parsePaletteInput("#panier")).toEqual({ kind: "missions", query: "panier" });
    expect(parsePaletteInput("/corr")).toEqual({ kind: "modes", query: "corr" });
    expect(parsePaletteInput(":42:7")).toEqual({ kind: "line", line: 42 });
    expect(parsePaletteInput(":abc")).toEqual({ kind: "line", line: null });
  });
});
