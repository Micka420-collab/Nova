// Global keymap (POWER_UX §2.4.2): resolves keydown events against the command registry, then the
// editor lane's workbench shortcuts (save, tabs) when the editor document is shown. The focused
// component owns its keys: in the editor or the terminal only `global` commands fire.
import { useEffect } from "react";
import { useToast } from "@nova/ui";
import { useAppStore } from "../../state/context";
import { resolveAtelierShortcut, type AtelierCommand } from "../editor/shortcuts";
import { useAtelierStore } from "../editor/atelier-context";
import type { AtelierState } from "../../state/editor-slice";
import { buildCommands, commandForEvent, focusRegionOf, runCommand } from "./registry";
import { useOptionalShellServices } from "../layout/AtelierHost";

const COMMANDS = buildCommands();

function runEditorCommand(atelier: AtelierState, command: AtelierCommand): boolean {
  const { editor } = atelier;
  const active = editor.activePath;
  switch (command.type) {
    case "save":
      if (!active) return false;
      void editor.save(active);
      return true;
    case "saveAll":
      void editor.saveAll();
      return true;
    case "closeTab":
      if (!active) return false;
      editor.closeTab(active);
      return true;
    case "reopenTab":
      void editor.reopenClosed();
      return true;
    case "cycleRecent":
      editor.cycleRecent(command.direction);
      return true;
    case "cycleOrder":
      editor.cycleOrder(command.direction);
      return true;
    case "goToTab": {
      const tab = editor.tabs[command.index];
      if (!tab) return false;
      editor.activate(tab.path);
      return true;
    }
    case "quickOpen":
    case "projectSearch":
      // Registry commands (`file.quickOpen`, `file.searchProject`) own these.
      return false;
  }
}

export function GlobalKeymap() {
  const store = useAppStore();
  const atelier = useAtelierStore();
  const toast = useToast();
  const companion = useOptionalShellServices()?.companion;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const state = store.getState();
      const ctx = { state, focus: focusRegionOf(document.activeElement) };
      const command = commandForEvent(COMMANDS, event, ctx);
      if (command) {
        event.preventDefault();
        void runCommand(command, ctx, { store, toast, companion });
        return;
      }
      if (!state.workspace.current || state.ui.activeDoc !== "editor") return;
      const editorCommand = resolveAtelierShortcut(event);
      if (editorCommand && runEditorCommand(atelier.getState(), editorCommand)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, atelier, toast, companion]);
  return null;
}
