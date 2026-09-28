// Command registry (POWER_UX §2.4.1): one list feeds the palette, the global keymap and the
// shortcut labels. Every command has a stable id (`category.action`), a French title, an optional
// context (`when`: absent otherwise) and an optional availability (`enabled`: visible but disabled
// with its reason). `run` never throws to its caller: failures become a toast.
import { WORK_MODES, type WorkMode, type ThemePreference } from "@nova/shared";
import type { ToastApi } from "@nova/ui";
import { fr } from "../../copy/fr";
import { WORK_MODE_LABELS } from "../../copy/fr-atelier";
import { errorToast } from "../../lib/errors";
import { liveMission, pendingApprovalList, selectedMissionView, type AppState, type AppStore } from "../../state/store";
import { isMissionActive, missionFacts, type MissionView } from "../missions/timeline";
import type { CompanionStore } from "../../state/companion-slice";
import { focusAgentComposer, focusZone } from "./zones";

export type CommandCategory =
  | "app"
  | "conversation"
  | "model"
  | "settings"
  | "view"
  | "layout"
  | "focus"
  | "file"
  | "review"
  | "mission"
  | "approval";

/** A key chord. `mod` = Ctrl on Windows/Linux, ⌘ on macOS (both accepted everywhere, like J1). */
export interface Shortcut {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Where the keyboard focus is: the editor and the terminal own most of their keys. */
export type FocusRegion = "editor" | "terminal" | "input" | "other";

export interface CommandContext {
  state: AppState;
  focus: FocusRegion;
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface CommandDeps {
  store: AppStore;
  toast: ToastApi;
  /** Nomi's store (P9/P12: its menu is reachable from the palette and the keyboard). */
  companion?: Pick<CompanionStore, "getState">;
}

export interface CommandDefinition {
  id: `${CommandCategory}.${string}`;
  title: string;
  category: CommandCategory;
  keywords?: readonly string[];
  keys?: readonly Shortcut[];
  /** Keys still fire when the editor or terminal has focus (POWER_UX §5.5 "global" list). */
  global?: boolean;
  /** Shown in the palette (default true); keyboard-only commands set false. */
  palette?: boolean;
  when?: (ctx: CommandContext) => boolean;
  enabled?: (ctx: CommandContext) => Availability;
  /** The result is ignored; a rejected promise becomes a toast. */
  run: (ctx: CommandContext, deps: CommandDeps) => unknown;
}

const c = fr.atelier.commands;
const MOD = { mod: true } as const;

function hasWorkspace(ctx: CommandContext): boolean {
  return ctx.state.workspace.current !== null;
}

/** Mission the mission commands act on: the shown one, else the running one. */
export function targetMission(state: AppState): MissionView | null {
  return selectedMissionView(state) ?? liveMission(state);
}

function needsWorkspace(ctx: CommandContext): Availability {
  return hasWorkspace(ctx) ? { ok: true } : { ok: false, reason: c.noWorkspace };
}

function streamingHere(state: AppState): boolean {
  return state.ui.route === "chat" && state.activeId !== null && state.streams[state.activeId] !== undefined;
}

function setTheme(theme: ThemePreference) {
  return (_: CommandContext, { store, toast }: CommandDeps) =>
    store
      .getState()
      .updateSettings({ theme })
      .catch((error: unknown) => toast.show(errorToast(error, fr.settings.saveFailed)));
}

function modeCommand(mode: WorkMode): CommandDefinition {
  return {
    id: `mission.mode.${mode}`,
    title: c.setMode(WORK_MODE_LABELS[mode]),
    category: "mission",
    keywords: ["mode", WORK_MODE_LABELS[mode].toLowerCase()],
    when: (ctx) => hasWorkspace(ctx) || mode === "discuss",
    run: (_, { store }) => {
      const state = store.getState();
      state.setWorkMode(mode);
      state.selectMission(null);
      state.setUi({ route: "chat", agentOpen: true });
    },
  };
}

export function buildCommands(): CommandDefinition[] {
  return [
    {
      id: "app.palette",
      title: fr.palette.title,
      category: "app",
      palette: false,
      global: true,
      keys: [{ key: "k", ...MOD }, { key: "p", mod: true, shift: true }, { key: "F1" }],
      run: (_, { store }) => {
        const { ui, setUi } = store.getState();
        setUi({ paletteOpen: !ui.paletteOpen });
      },
    },
    {
      // P12: Nomi's menu (every Nomi action) from anywhere, without the mouse.
      id: "app.nomiMenu",
      title: c.nomiMenu,
      category: "app",
      keywords: ["nomi", "compagnon", "menu"],
      keys: [{ key: "n", mod: true, shift: true }],
      when: (ctx) => ctx.state.settings?.companion.visible !== false,
      run: (_, { store, companion }) => {
        store.getState().setUi({ paletteOpen: false });
        companion?.getState().setMenuOpen(true);
      },
    },
    {
      id: "conversation.new",
      title: fr.palette.newConversation,
      category: "conversation",
      keys: [{ key: "n", ...MOD }],
      run: (_, { store }) => {
        store.getState().setUi({ paletteOpen: false });
        store.getState().newConversation();
      },
    },
    {
      id: "model.pick",
      title: fr.palette.changeModel,
      category: "model",
      keys: [{ key: "m", mod: true, shift: true }],
      run: (ctx, { store }) => store.getState().openModelPicker(ctx.state.ui.route === "chat" ? "conversation" : "new"),
    },
    {
      id: "conversation.stop",
      title: fr.palette.stop,
      category: "conversation",
      keys: [{ key: "Escape", shift: true }],
      when: (ctx) => streamingHere(ctx.state),
      run: (ctx, { store, toast }) => {
        const id = ctx.state.activeId;
        if (!id) return;
        store
          .getState()
          .stop(id)
          .catch((error: unknown) => toast.show(errorToast(error, fr.palette.stop)));
      },
    },
    {
      id: "app.settings",
      title: fr.palette.settings,
      category: "app",
      keys: [{ key: ",", ...MOD }],
      run: (_, { store }) => {
        store.getState().setUi({ paletteOpen: false });
        store.getState().openSettings();
      },
    },
    { id: "app.home", title: fr.palette.home, category: "app", run: (_, { store }) => store.getState().goHome() },
    { id: "view.themeLight", title: fr.palette.themeLight, category: "view", keywords: ["thème", "clair"], run: setTheme("light") },
    { id: "view.themeDark", title: fr.palette.themeDark, category: "view", keywords: ["thème", "sombre"], run: setTheme("dark") },
    { id: "view.themeSystem", title: fr.palette.themeSystem, category: "view", keywords: ["thème", "système"], run: setTheme("system") },
    {
      id: "view.toggleExpert",
      title: c.toggleDisplay,
      category: "view",
      keywords: ["expert", "créer", "affichage"],
      keys: [{ key: "e", mod: true, shift: true }],
      run: (_, { store }) => store.getState().toggleDisplayMode(),
    },
    {
      id: "layout.toggleMode",
      title: c.toggleLayout,
      category: "layout",
      keywords: ["disposition", "construction", "conversation"],
      keys: [{ key: "d", mod: true, shift: true }],
      run: (_, { store }) => store.getState().toggleLayout(),
    },
    {
      id: "layout.toggleExplorer",
      title: c.toggleExplorer,
      category: "layout",
      keys: [{ key: "b", ...MOD }],
      run: (_, { store }) => {
        const { ui, setUi } = store.getState();
        setUi({ explorerOpen: !ui.explorerOpen });
      },
    },
    {
      id: "layout.toggleAgent",
      title: c.toggleAgent,
      category: "layout",
      keywords: ["agent", "nomi"],
      keys: [{ key: "i", ...MOD }],
      run: (_, { store }) => {
        const { ui, setUi } = store.getState();
        if (ui.layout === "converse") setUi({ route: "chat" });
        else setUi({ agentOpen: !(ui.agentOpen && ui.route === "chat"), route: "chat" });
      },
    },
    {
      id: "layout.toggleDock",
      title: c.toggleDock,
      category: "layout",
      keywords: ["terminal"],
      keys: [{ key: "j", ...MOD }],
      global: true,
      when: hasWorkspace,
      run: (_, { store }) => {
        const { ui, setUi } = store.getState();
        setUi({ dockOpen: !ui.dockOpen, ...(ui.layout === "converse" ? { workbenchOpen: true } : {}) });
      },
    },
    {
      id: "focus.nextZone",
      title: c.nextZone,
      category: "focus",
      keywords: ["zone", "panneau", "focus"],
      keys: [{ key: "F6" }],
      global: true,
      run: () => focusZone(1),
    },
    {
      id: "focus.previousZone",
      title: c.previousZone,
      category: "focus",
      keywords: ["zone", "panneau", "focus"],
      keys: [{ key: "F6", shift: true }],
      global: true,
      run: () => focusZone(-1),
    },
    {
      id: "focus.composer",
      title: c.focusComposer,
      category: "focus",
      keywords: ["composer", "message", "objectif"],
      keys: [{ key: "l", ...MOD }],
      global: true,
      run: (_, { store }) => {
        const { ui, setUi } = store.getState();
        setUi({ route: "chat", paletteOpen: false, ...(ui.layout === "build" ? { agentOpen: true } : {}) });
        focusAgentComposer();
      },
    },
    { id: "layout.showConversations", title: c.showConversations, category: "layout", run: (_, { store }) => store.getState().showExplorer("conversations") },
    { id: "layout.showFiles", title: c.showFiles, category: "layout", run: (_, { store }) => store.getState().showExplorer("files") },
    { id: "layout.showMissions", title: c.showMissions, category: "layout", run: (_, { store }) => store.getState().showExplorer("missions") },
    {
      id: "file.openFolder",
      title: c.openFolder,
      category: "file",
      keywords: ["dossier", "projet", "workspace"],
      run: (_, { store, toast }) =>
        store
          .getState()
          .openWorkspace()
          .catch((error: unknown) => toast.show(errorToast(error, fr.atelier.shell.folderOpenFailed))),
    },
    {
      id: "file.closeFolder",
      title: c.closeFolder,
      category: "file",
      when: hasWorkspace,
      run: (_, { store, toast }) =>
        store
          .getState()
          .closeWorkspace()
          .catch((error: unknown) => toast.show(errorToast(error, c.closeFolder))),
    },
    {
      id: "file.quickOpen",
      title: c.quickOpen,
      category: "file",
      palette: false,
      keys: [{ key: "p", ...MOD }],
      when: hasWorkspace,
      run: (_, { store }) => store.getState().setUi({ quickOpen: true, paletteOpen: false }),
    },
    {
      id: "file.searchProject",
      title: fr.atelier.shell.search,
      category: "file",
      keys: [{ key: "f", mod: true, shift: true }],
      when: hasWorkspace,
      run: (_, { store }) => store.getState().showExplorer("search"),
    },
    {
      id: "app.extensions",
      title: c.openExtensions,
      category: "app",
      keywords: ["mcp", "serveur", "connecteur"],
      run: (_, { store }) => store.getState().openDoc({ kind: "extensions" }),
    },
    ...WORK_MODES.map(modeCommand),
    {
      id: "review.open",
      title: c.openChanges,
      category: "review",
      keywords: ["diff", "changements", "relire"],
      when: (ctx) => targetMission(ctx.state) !== null,
      enabled: (ctx) => {
        const view = targetMission(ctx.state);
        return view && missionFacts(view).files.length > 0 ? { ok: true } : { ok: false, reason: fr.atelier.end.noChanges };
      },
      run: (ctx, { store }) => {
        const view = targetMission(ctx.state);
        if (view) store.getState().openDoc({ kind: "diff", missionId: view.mission.id });
      },
    },
    {
      id: "mission.card",
      title: c.openMissionCard,
      category: "mission",
      when: (ctx) => targetMission(ctx.state) !== null,
      run: (ctx, { store }) => {
        const view = targetMission(ctx.state);
        if (view) store.getState().openDoc({ kind: "mission", missionId: view.mission.id });
      },
    },
    {
      id: "mission.timeline",
      title: c.showTimeline,
      category: "mission",
      keywords: ["journal", "chronologie"],
      keys: [{ key: "i", mod: true, shift: true }],
      when: (ctx) => targetMission(ctx.state) !== null,
      run: (ctx, { store }) => {
        const view = targetMission(ctx.state);
        if (!view) return;
        const state = store.getState();
        state.selectMission(view.mission.id);
        state.setUi({ route: "chat", agentOpen: true, paletteOpen: false });
      },
    },
    {
      id: "mission.checkpoints",
      title: c.openCheckpoints,
      category: "mission",
      keywords: ["restaurer", "retour", "point de reprise"],
      when: hasWorkspace,
      run: (ctx, { store }) =>
        store.getState().openDoc({ kind: "checkpoints", missionId: targetMission(ctx.state)?.mission.id ?? null }),
    },
    {
      id: "mission.pause",
      title: c.pauseMission,
      category: "mission",
      when: (ctx) => {
        const state = targetMission(ctx.state)?.mission.state;
        return state === "running" || state === "waiting_approval";
      },
      run: (ctx, { store, toast }) => {
        const view = targetMission(ctx.state);
        if (!view) return;
        store
          .getState()
          .pauseMission(view.mission.id)
          .catch((error: unknown) => toast.show(errorToast(error, fr.atelier.mission.actionFailed)));
      },
    },
    {
      id: "mission.resume",
      title: c.resumeMission,
      category: "mission",
      when: (ctx) => targetMission(ctx.state)?.mission.state === "suspended",
      run: (ctx, { store, toast }) => {
        const view = targetMission(ctx.state);
        if (!view) return;
        store
          .getState()
          .resumeMission(view.mission.id)
          .catch((error: unknown) => toast.show(errorToast(error, fr.atelier.mission.actionFailed)));
      },
    },
    {
      id: "mission.stop",
      title: c.stopMission,
      category: "mission",
      when: (ctx) => {
        const view = targetMission(ctx.state);
        return view !== null && isMissionActive(view);
      },
      run: (ctx, { store, toast }) => {
        const view = targetMission(ctx.state);
        if (!view) return;
        store
          .getState()
          .stopMission(view.mission.id)
          .catch((error: unknown) => toast.show(errorToast(error, fr.atelier.mission.actionFailed)));
      },
    },
    {
      id: "approval.focus",
      title: c.goToApproval,
      category: "approval",
      keys: [{ key: "a", mod: true, shift: true }],
      global: true,
      when: (ctx) => pendingApprovalList(ctx.state).length > 0,
      run: (ctx, { store }) => {
        const oldest = pendingApprovalList(ctx.state)[0];
        if (oldest) {
          store.getState().setUi({ paletteOpen: false });
          store.getState().focusApproval(oldest.id);
        }
      },
    },
    { id: "settings.budget", title: c.openBudget, category: "settings", run: (_, { store }) => store.getState().openSettings("budget") },
    {
      id: "settings.permissions",
      title: c.openPermissions,
      category: "settings",
      enabled: needsWorkspace,
      run: (_, { store }) => store.getState().openSettings("permissions"),
    },
    { id: "settings.internet", title: c.openInternet, category: "settings", run: (_, { store }) => store.getState().openSettings("internet") },
    { id: "settings.audit", title: c.openAudit, category: "settings", run: (_, { store }) => store.getState().openSettings("audit") },
  ];
}

// ---------------------------------------------------------------------------
// Keys

export type KeyEventLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { isComposing?: boolean };

export function matchesShortcut(event: KeyEventLike, shortcut: Shortcut): boolean {
  const mod = event.ctrlKey || event.metaKey;
  if (Boolean(shortcut.mod) !== mod) return false;
  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  if (Boolean(shortcut.alt) !== event.altKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return key === shortcut.key;
}

/** First command bound to this key event in this context (AltGr and IME composition ignored). */
export function commandForEvent(
  commands: readonly CommandDefinition[],
  event: KeyEventLike,
  ctx: CommandContext,
): CommandDefinition | null {
  if (event.isComposing) return null;
  // AltGr = Ctrl+Alt on Windows/Linux: never a NOVA shortcut (POWER_UX §2.1).
  if (event.ctrlKey && event.altKey) return null;
  for (const command of commands) {
    if (!command.keys?.some((shortcut) => matchesShortcut(event, shortcut))) continue;
    if ((ctx.focus === "editor" || ctx.focus === "terminal") && !command.global) continue;
    if (command.when && !command.when(ctx)) continue;
    if (command.enabled && !command.enabled(ctx).ok) continue;
    return command;
  }
  return null;
}

export function shortcutId(shortcut: Shortcut): string {
  return [shortcut.mod ? "Mod" : "", shortcut.shift ? "Shift" : "", shortcut.alt ? "Alt" : "", shortcut.key.toLowerCase()]
    .filter(Boolean)
    .join("+");
}

const KEY_LABELS: Record<string, string> = { Escape: "Échap", Enter: "Entrée", ",": ",", " ": "Espace" };

/** Display label: "Ctrl+Maj+D" (or "⌘⇧D" on macOS). */
export function formatShortcut(shortcut: Shortcut, mac: boolean): string {
  const key = KEY_LABELS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  if (mac) return `${shortcut.mod ? "⌘" : ""}${shortcut.shift ? "⇧" : ""}${shortcut.alt ? "⌥" : ""}${key}`;
  return [shortcut.mod ? "Ctrl" : "", shortcut.shift ? "Maj" : "", shortcut.alt ? "Alt" : "", key].filter(Boolean).join("+");
}

/** `aria-keyshortcuts` value ("Control+Shift+D Meta+Shift+D"). */
export function ariaKeyShortcuts(shortcut: Shortcut): string {
  const parts = (mod: string | null) =>
    [mod, shortcut.shift ? "Shift" : null, shortcut.alt ? "Alt" : null, shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key]
      .filter(Boolean)
      .join("+");
  return shortcut.mod ? `${parts("Control")} ${parts("Meta")}` : parts(null);
}

/** Palette entries in this context: `when` false hides, `enabled` false shows disabled with its reason. */
export function paletteCommands(
  commands: readonly CommandDefinition[],
  ctx: CommandContext,
): Array<{ command: CommandDefinition; availability: Availability }> {
  return commands
    .filter((command) => command.palette !== false && (!command.when || command.when(ctx)))
    .map((command) => ({ command, availability: command.enabled ? command.enabled(ctx) : { ok: true as const } }));
}

/** Runs a command; errors never reach the caller (they are shown). */
export async function runCommand(command: CommandDefinition, ctx: CommandContext, deps: CommandDeps): Promise<void> {
  try {
    await command.run(ctx, deps);
  } catch (error) {
    deps.toast.show(errorToast(error, command.title));
  }
}

export function focusRegionOf(element: Element | null): FocusRegion {
  if (!element) return "other";
  if (element.closest(".cm-editor")) return "editor";
  if (element.closest(".xterm")) return "terminal";
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)) {
    return "input";
  }
  return "other";
}
