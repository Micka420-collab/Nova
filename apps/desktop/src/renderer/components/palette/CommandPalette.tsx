// Command palette (VISUAL.md §4.9, POWER_UX §2.4): commands from the registry, plus prefixes —
// `>` commands, `@` project files, `#` missions, `/` work modes, `:` go to line. A search never ends on nothing:
// "Demander à Nomi" puts the text in the composer.
import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { Dialog, Kbd, useToast } from "@nova/ui";
import type { ConversationSummary } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeUiError, toUiError } from "../../lib/errors";
import { useApp, useAppStore, useClient } from "../../state/context";
import type { AppState } from "../../state/store";
import { useAtelier } from "../editor/atelier-context";
import { MOD_KEY } from "../../lib/platform";
import {
  buildCommands,
  focusRegionOf,
  formatShortcut,
  paletteCommands,
  runCommand,
  type CommandCategory,
  type CommandContext,
} from "./registry";
import { useOptionalShellServices } from "../layout/AtelierHost";

type Page = "commands" | "conversations";

const SEARCH_DELAY_MS = 150;
const COMMANDS = buildCommands();
const IS_MAC = MOD_KEY === "⌘";
const c = fr.atelier.commands;

const CATEGORY_ORDER: readonly CommandCategory[] = [
  "conversation",
  "mission",
  "approval",
  "review",
  "file",
  "layout",
  "focus",
  "view",
  "model",
  "app",
  "settings",
];

export type PaletteMode =
  | { kind: "commands"; query: string }
  | { kind: "files"; query: string }
  | { kind: "missions"; query: string }
  | { kind: "modes"; query: string }
  | { kind: "line"; line: number | null };

/** Reads the prefix of the palette input (POWER_UX §2.4.5). */
export function parsePaletteInput(value: string): PaletteMode {
  const first = value.charAt(0);
  const rest = value.slice(1).trim();
  if (first === ">") return { kind: "commands", query: rest };
  if (first === "@") return { kind: "files", query: rest };
  if (first === "#") return { kind: "missions", query: rest };
  if (first === "/") return { kind: "modes", query: rest };
  if (first === ":") {
    const match = /^(\d{1,7})(?::\d{1,5})?$/.exec(rest);
    return { kind: "line", line: match?.[1] ? Number(match[1]) : null };
  }
  return { kind: "commands", query: value.trim() };
}

/** Accent- and case-insensitive: every word of the query appears in the text. */
export function matchesQuery(text: string, query: string): boolean {
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const haystack = normalize(text);
  return normalize(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

interface Results<T> {
  query: string | null;
  items: T[];
  hasMore: boolean;
  error: string | null;
}

interface Search<T> extends Results<T> {
  loading: boolean;
}

/** Debounced search in main; results for an older query mean a search is in flight. */
function useRemoteSearch<T>(query: string, enabled: boolean, load: (query: string) => Promise<{ items: T[]; hasMore: boolean }>): Search<T> {
  const [results, setResults] = useState<Results<T>>({ query: null, items: [], hasMore: false, error: null });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const timer = setTimeout(() => {
      loadRef
        .current(query)
        .then((page) => {
          if (current) setResults({ query, items: page.items, hasMore: page.hasMore, error: null });
        })
        .catch((error: unknown) => {
          if (current) setResults({ query, items: [], hasMore: false, error: describeUiError(toUiError(error)).title });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, enabled]);
  return { ...results, loading: results.query !== query };
}

function ConversationResults({ results, onOpen }: { results: Search<ConversationSummary>; onOpen: (id: string) => void }) {
  return (
    <Command.Group heading={fr.palette.groupConversations}>
      {results.loading && results.items.length === 0 ? (
        <Command.Loading label={fr.palette.loadingConversations}>{fr.palette.loadingConversations}</Command.Loading>
      ) : null}
      {results.error
        ? null
        : results.items.map((item) => (
            <Command.Item key={item.id} value={item.id} onSelect={() => onOpen(item.id)}>
              <span className="nova-palette__item-title">{item.title}</span>
              {item.preview ? <span className="nova-palette__item-hint">{item.preview}</span> : null}
            </Command.Item>
          ))}
    </Command.Group>
  );
}

/**
 * Outcome of a finished search, outside the list: the "back" item keeps cmdk's item count above
 * zero, so Command.Empty would never render on this page.
 */
function SearchOutcome<T>({ results, empty }: { results: Search<T>; empty: string }) {
  if (results.loading) return null;
  if (results.error) {
    return (
      <p className="nova-palette__outcome" role="alert">
        {results.error}
      </p>
    );
  }
  if (results.items.length === 0) return <output className="nova-palette__outcome">{empty}</output>;
  return results.hasMore ? <p className="nova-palette__outcome">{fr.nav.moreResults}</p> : null;
}

function commandContext(state: AppState): CommandContext {
  return { state, focus: focusRegionOf(document.activeElement) };
}

function PaletteContent({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const store = useAppStore();
  const state = useApp((s) => s);
  const activePath = useAtelier((s) => s.editor.activePath);
  const toast = useToast();
  const companion = useOptionalShellServices()?.companion;
  const input = useRef<HTMLInputElement>(null);
  // Focus region captured when the palette opened (the palette itself now has focus).
  const [openerFocus] = useState(() => focusRegionOf(document.activeElement));
  const [page, setPage] = useState<Page>("commands");
  const [search, setSearch] = useState("");
  const mode = parsePaletteInput(search);
  const workspaceId = state.workspace.current?.id ?? null;

  const conversations = useRemoteSearch<ConversationSummary>(search.trim(), page === "conversations", (query) =>
    client.conversations.list(query ? { query } : {}),
  );
  const files = useRemoteSearch<string>(
    mode.kind === "files" ? mode.query : "",
    page === "commands" && mode.kind === "files" && workspaceId !== null,
    async (query) => {
      if (!workspaceId) return { items: [], hasMore: false };
      const result = await client.search.files({ workspaceId, query, limit: 50 });
      return { items: result.paths, hasMore: result.truncated };
    },
  );

  // After the dialog's own initial focus (its close button), the search field takes over.
  useEffect(() => {
    input.current?.focus();
  }, []);

  const entries = paletteCommands(COMMANDS, { state, focus: openerFocus });

  const showPage = (next: Page) => {
    setSearch("");
    setPage(next);
    input.current?.focus();
  };

  const run = (action: () => void) => {
    onClose();
    action();
  };

  const askNomi = (text: string) =>
    run(() => {
      const current = store.getState();
      current.setDraft(current.activeId, text);
      current.setUi({ route: "chat", agentOpen: true });
    });

  const renderCommands = (query: string) => {
    const visible = entries.filter(({ command }) => matchesQuery(`${command.title} ${(command.keywords ?? []).join(" ")}`, query));
    return (
      <>
        {!query ? (
          <Command.Group heading={fr.palette.groupActions}>
            <Command.Item value="__search-conversations" onSelect={() => showPage("conversations")}>
              {fr.palette.searchConversation}
            </Command.Item>
          </Command.Group>
        ) : null}
        {CATEGORY_ORDER.map((category) => {
          const group = visible.filter(({ command }) => command.category === category);
          if (group.length === 0) return null;
          return (
            <Command.Group key={category} heading={c.groups[category]}>
              {group.map(({ command, availability }) => {
                const shortcut = command.keys?.[0];
                return (
                  <Command.Item
                    key={command.id}
                    value={command.id}
                    disabled={!availability.ok}
                    onSelect={() => run(() => void runCommand(command, commandContext(store.getState()), { store, toast, companion }))}
                  >
                    <span className="nova-palette__item-title">{command.title}</span>
                    {!availability.ok ? <span className="nova-palette__item-hint">{availability.reason}</span> : null}
                    {shortcut ? <Kbd className="nova-palette__kbd">{formatShortcut(shortcut, IS_MAC)}</Kbd> : null}
                  </Command.Item>
                );
              })}
            </Command.Group>
          );
        })}
        {query ? (
          <Command.Group heading={fr.atelier.agent.nomi}>
            <Command.Item value="__ask-nomi" onSelect={() => askNomi(query)}>
              {c.askNomi(query)}
            </Command.Item>
          </Command.Group>
        ) : null}
      </>
    );
  };

  const renderFiles = () => {
    if (!workspaceId) return <p className="nova-palette__outcome">{c.noWorkspace}</p>;
    return (
      <Command.Group heading={c.filesGroup}>
        {files.loading && files.items.length === 0 ? <Command.Loading label={c.filesLoading}>{c.filesLoading}</Command.Loading> : null}
        {files.items.map((path) => (
          <Command.Item key={path} value={`@${path}`} onSelect={() => run(() => state.revealFile(path, null))}>
            <span className="nova-palette__item-title">{path.split("/").at(-1) ?? path}</span>
            <span className="nova-palette__item-hint">{path}</span>
          </Command.Item>
        ))}
      </Command.Group>
    );
  };

  const renderMissions = (query: string) => {
    const matches = state.missions.list.filter((mission) => matchesQuery(`${mission.title} ${mission.goal}`, query));
    if (matches.length === 0) return <output className="nova-palette__outcome">{c.missionsEmpty}</output>;
    return (
      <Command.Group heading={c.missionsGroup}>
        {matches.map((mission) => (
          <Command.Item
            key={mission.id}
            value={`#${mission.id}`}
            onSelect={() =>
              run(() => {
                state.selectMission(mission.id);
                state.openDoc({ kind: "mission", missionId: mission.id });
              })
            }
          >
            <span className="nova-palette__item-title">{mission.title}</span>
            <span className="nova-palette__item-hint">{mission.goal}</span>
          </Command.Item>
        ))}
      </Command.Group>
    );
  };

  const renderModes = (query: string) => {
    const modes = entries.filter(
      ({ command }) => command.id.startsWith("mission.mode.") && matchesQuery(`${command.title} ${(command.keywords ?? []).join(" ")}`, query),
    );
    if (modes.length === 0) return <output className="nova-palette__outcome">{c.modesEmpty}</output>;
    return (
      <Command.Group heading={c.modesGroup}>
        {modes.map(({ command }) => (
          <Command.Item
            key={command.id}
            value={`/${command.id}`}
            onSelect={() => run(() => void runCommand(command, commandContext(store.getState()), { store, toast, companion }))}
          >
            <span className="nova-palette__item-title">{command.title}</span>
          </Command.Item>
        ))}
      </Command.Group>
    );
  };

  const renderLine = (line: number | null) => {
    if (line === null) return <p className="nova-palette__outcome">{c.lineHint}</p>;
    if (!activePath) return <p className="nova-palette__outcome">{c.goToLineUnavailable}</p>;
    return (
      <Command.Group>
        <Command.Item value={`:${line}`} onSelect={() => run(() => state.revealFile(activePath, line))}>
          {c.goToLine(line)}
        </Command.Item>
      </Command.Group>
    );
  };

  return (
    <Command
      label={fr.palette.label}
      className="nova-palette"
      shouldFilter={false}
      vimBindings={false}
      loop
      onKeyDown={(event) => {
        if (page === "conversations" && event.key === "Backspace" && search === "") {
          event.preventDefault();
          showPage("commands");
        }
      }}
    >
      <Command.Input
        ref={input}
        value={search}
        onValueChange={setSearch}
        placeholder={page === "commands" ? fr.palette.placeholder : fr.palette.searchPlaceholder}
        className="nv-field__control nova-palette__input"
      />
      <Command.List className="nova-palette__list">
        {page === "commands" ? (
          <>
            {mode.kind === "commands" ? renderCommands(mode.query) : null}
            {mode.kind === "files" ? renderFiles() : null}
            {mode.kind === "missions" ? renderMissions(mode.query) : null}
            {mode.kind === "modes" ? renderModes(mode.query) : null}
            {mode.kind === "line" ? renderLine(mode.line) : null}
          </>
        ) : (
          <>
            <Command.Group>
              <Command.Item value="__back" onSelect={() => showPage("commands")}>
                {fr.palette.back}
              </Command.Item>
            </Command.Group>
            <ConversationResults results={conversations} onOpen={(id) => run(() => state.openConversation(id))} />
          </>
        )}
      </Command.List>
      {page === "conversations" ? <SearchOutcome results={conversations} empty={fr.palette.emptyConversations} /> : null}
      {page === "commands" && mode.kind === "files" && workspaceId ? <SearchOutcome results={files} empty={c.filesEmpty} /> : null}
      {page === "commands" ? <p className="nova-palette__footer">{c.prefixes}</p> : null}
    </Command>
  );
}

export function CommandPalette() {
  const open = useApp((state) => state.ui.paletteOpen);
  const setUi = useApp((state) => state.setUi);
  const close = () => setUi({ paletteOpen: false });
  return (
    <Dialog open={open} onClose={close} title={fr.palette.title} size="md" className="nova-palette-dialog">
      {open ? <PaletteContent onClose={close} /> : null}
    </Dialog>
  );
}
