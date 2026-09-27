import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { Dialog, useToast } from "@nova/ui";
import type { ConversationSummary, ThemePreference } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeUiError, errorToast, toUiError } from "../../lib/errors";
import { useApp, useClient } from "../../state/context";

type Page = "commands" | "conversations";

const SEARCH_DELAY_MS = 150;

interface Results {
  /** Query these results answer; results for an older query mean a search is in flight. */
  query: string | null;
  items: ConversationSummary[];
  hasMore: boolean;
  error: string | null;
}

interface Search extends Results {
  loading: boolean;
}

/** Conversations matching `search`, searched in main (titles and message contents) like the sidebar. */
function useConversationSearch(search: string, enabled: boolean): Search {
  const client = useClient();
  const [results, setResults] = useState<Results>({ query: null, items: [], hasMore: false, error: null });
  const query = search.trim();

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const timer = setTimeout(() => {
      client.conversations
        .list(query ? { query } : {})
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
  }, [client, query, enabled]);

  return { ...results, loading: results.query !== query };
}

function ConversationResults({ results, onOpen }: { results: Search; onOpen: (id: string) => void }) {
  return (
    <Command.Group heading={fr.palette.groupConversations}>
      {results.loading && results.items.length === 0 ? (
        <Command.Loading label={fr.palette.loadingConversations}>{fr.palette.loadingConversations}</Command.Loading>
      ) : null}
      {results.error ? null : results.items.map((item) => (
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
function SearchOutcome({ results }: { results: Search }) {
  if (results.loading) return null;
  if (results.error) {
    return (
      <p className="nova-palette__outcome" role="alert">
        {results.error}
      </p>
    );
  }
  if (results.items.length === 0) {
    return (
      <output className="nova-palette__outcome">{fr.palette.emptyConversations}</output>
    );
  }
  return results.hasMore ? <p className="nova-palette__outcome">{fr.nav.moreResults}</p> : null;
}

function PaletteContent({ onClose }: { onClose: () => void }) {
  const streaming = useApp((state) => (state.activeId ? state.streams[state.activeId] !== undefined : false));
  const activeId = useApp((state) => state.activeId);
  const newConversation = useApp((state) => state.newConversation);
  const openConversation = useApp((state) => state.openConversation);
  const openSettings = useApp((state) => state.openSettings);
  const goHome = useApp((state) => state.goHome);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const route = useApp((state) => state.ui.route);
  const stop = useApp((state) => state.stop);
  const updateSettings = useApp((state) => state.updateSettings);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<Page>("commands");
  const [search, setSearch] = useState("");
  const results = useConversationSearch(search, page === "conversations");

  // After the dialog's own initial focus (its close button), the search field takes over.
  useEffect(() => {
    input.current?.focus();
  }, []);

  const showPage = (next: Page) => {
    setSearch("");
    setPage(next);
    input.current?.focus();
  };

  const run = (action: () => void) => {
    onClose();
    action();
  };
  const setTheme = (theme: ThemePreference) =>
    run(() => {
      updateSettings({ theme }).catch((error: unknown) => toast.show(errorToast(error, fr.settings.saveFailed)));
    });

  return (
    <Command
      label={fr.palette.label}
      className="nova-palette"
      shouldFilter={page === "commands"}
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
            <Command.Empty>{fr.palette.empty}</Command.Empty>
            <Command.Group heading={fr.palette.groupActions}>
              <Command.Item onSelect={() => run(newConversation)}>{fr.palette.newConversation}</Command.Item>
              <Command.Item onSelect={() => showPage("conversations")}>{fr.palette.searchConversation}</Command.Item>
              <Command.Item onSelect={() => run(() => openModelPicker(route === "chat" ? "conversation" : "new"))}>
                {fr.palette.changeModel}
              </Command.Item>
              {streaming && activeId && route === "chat" ? (
                <Command.Item
                  onSelect={() =>
                    run(() => {
                      stop(activeId).catch((error: unknown) => toast.show(errorToast(error, fr.palette.stop)));
                    })
                  }
                >
                  {fr.palette.stop}
                </Command.Item>
              ) : null}
              <Command.Item onSelect={() => run(() => openSettings())}>{fr.palette.settings}</Command.Item>
              <Command.Item onSelect={() => run(goHome)}>{fr.palette.home}</Command.Item>
            </Command.Group>
            <Command.Group heading={fr.palette.groupTheme}>
              <Command.Item onSelect={() => setTheme("light")}>{fr.palette.themeLight}</Command.Item>
              <Command.Item onSelect={() => setTheme("dark")}>{fr.palette.themeDark}</Command.Item>
              <Command.Item onSelect={() => setTheme("system")}>{fr.palette.themeSystem}</Command.Item>
            </Command.Group>
          </>
        ) : (
          <>
            <Command.Group>
              <Command.Item value="__back" onSelect={() => showPage("commands")}>
                {fr.palette.back}
              </Command.Item>
            </Command.Group>
            <ConversationResults results={results} onOpen={(id) => run(() => openConversation(id))} />
          </>
        )}
      </Command.List>
      {page === "conversations" ? <SearchOutcome results={results} /> : null}
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
