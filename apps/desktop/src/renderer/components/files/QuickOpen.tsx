// Quick open (Ctrl/Cmd+P, FEATURES E10): fuzzy file search over main's file index, re-ranked with
// the recently used files. `app.ts:42` opens at a line.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import { Dialog } from "@nova/ui";
import { describeUiError, toUiError } from "../../lib/errors";
import { useAtelier, useAtelierClient, useAtelierStore } from "../editor/atelier-context";
import { parseQuickOpenQuery, rankPaths, type RankedPath } from "./fuzzy";
import { quickOpenCopy as copy } from "./search-copy";
// oxlint-disable-next-line import/no-unassigned-import -- side-effect stylesheet (extracted to a file by Vite)
import "./search.css";

const SEARCH_DELAY_MS = 80;
const REQUEST_LIMIT = 200;
const SHOWN_LIMIT = 50;
const RECENT_SHOWN = 10;

interface Results {
  /** Text these results answer; an older text means a request is in flight. */
  text: string | null;
  items: RankedPath[];
  truncated: boolean;
  error: string | null;
}

const EMPTY_RESULTS: Results = { text: null, items: [], truncated: false, error: null };

/** Path with its matched characters marked: basename first, then the directory, dimmed. */
function HighlightedPath({ path, positions }: { path: string; positions: readonly number[] }) {
  const slash = path.lastIndexOf("/");
  const marked = new Set(positions);
  const render = (start: number, end: number) => {
    const parts: ReactNode[] = [];
    let run = "";
    let runMarked = false;
    const flush = (key: number) => {
      if (run === "") return;
      parts.push(runMarked ? <mark key={key} className="nv-quick-open__hit">{run}</mark> : run);
      run = "";
    };
    for (let index = start; index < end; index += 1) {
      const isMarked = marked.has(index);
      if (isMarked !== runMarked) {
        flush(index);
        runMarked = isMarked;
      }
      run += path[index] ?? "";
    }
    flush(end);
    return parts;
  };
  return (
    <>
      <span className="nv-quick-open__name">{render(slash + 1, path.length)}</span>
      {slash > 0 ? <span className="nv-quick-open__dir">{render(0, slash)}</span> : null}
    </>
  );
}

function QuickOpenContent({ onClose }: { onClose: () => void }) {
  const client = useAtelierClient();
  const store = useAtelierStore();
  const workspaceId = useAtelier((state) => state.explorer.workspaceId);
  const mru = useAtelier((state) => state.editor.mru);
  const tabs = useAtelier((state) => state.editor.tabs);
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Results>(EMPTY_RESULTS);
  const query = parseQuickOpenQuery(search);
  const text = query.text;

  // After the dialog's own initial focus (its close button), the search field takes over.
  useEffect(() => {
    input.current?.focus();
  }, []);

  const openPaths = useMemo(() => new Set(tabs.map((tab) => tab.path)), [tabs]);

  useEffect(() => {
    if (!workspaceId || text === "") return;
    let current = true;
    const timer = setTimeout(() => {
      client.search
        .files({ workspaceId, query: text, limit: REQUEST_LIMIT })
        .then((found) => {
          if (!current) return;
          const ranked = rankPaths(text, found.paths, { recent: mru, open: openPaths });
          setResults({ text, items: ranked.slice(0, SHOWN_LIMIT), truncated: found.truncated, error: null });
        })
        .catch((error: unknown) => {
          if (current) setResults({ text, items: [], truncated: false, error: describeUiError(toUiError(error)).title });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, text, mru, openPaths]);

  const recent = useMemo(() => {
    const paths = [...mru, ...tabs.map((tab) => tab.path)];
    return [...new Set(paths)].slice(0, RECENT_SHOWN);
  }, [mru, tabs]);

  const open = (path: string) => {
    onClose();
    const options = query.line === null ? {} : { line: query.line, ...(query.column === null ? {} : { from: query.column - 1 }) };
    void store.getState().editor.openFile(path, options);
  };

  const loading = text !== "" && results.text !== text;
  const shown = text === "" ? [] : results.items;

  return (
    <Command label={copy.title} className="nova-palette nv-quick-open" shouldFilter={false} vimBindings={false} loop>
      <Command.Input
        ref={input}
        value={search}
        onValueChange={setSearch}
        aria-label={copy.inputLabel}
        placeholder={copy.placeholder}
        className="nv-field__control nova-palette__input"
        disabled={!workspaceId}
      />
      <Command.List className="nova-palette__list">
        {!workspaceId ? null : text === "" ? (
          recent.length > 0 ? (
            <Command.Group heading={copy.groupRecent}>
              {recent.map((path) => (
                <Command.Item key={path} value={path} onSelect={() => open(path)}>
                  <HighlightedPath path={path} positions={[]} />
                </Command.Item>
              ))}
            </Command.Group>
          ) : null
        ) : (
          <Command.Group heading={copy.groupResults}>
            {loading && shown.length === 0 ? <Command.Loading label={copy.loading}>{copy.loading}</Command.Loading> : null}
            {results.text === text
              ? shown.map((item) => (
                  <Command.Item key={item.path} value={item.path} onSelect={() => open(item.path)}>
                    <HighlightedPath path={item.path} positions={item.positions} />
                    {query.line !== null ? (
                      <span className="nova-palette__item-hint">{copy.lineHint(query.line)}</span>
                    ) : null}
                  </Command.Item>
                ))
              : null}
          </Command.Group>
        )}
      </Command.List>
      <QuickOpenOutcome
        workspaceOpen={Boolean(workspaceId)}
        text={text}
        loading={loading}
        results={results}
        hasRecent={recent.length > 0}
      />
    </Command>
  );
}

function QuickOpenOutcome({
  workspaceOpen,
  text,
  loading,
  results,
  hasRecent,
}: {
  workspaceOpen: boolean;
  text: string;
  loading: boolean;
  results: Results;
  hasRecent: boolean;
}) {
  if (!workspaceOpen) return <output className="nova-palette__outcome">{copy.noWorkspace}</output>;
  if (text === "") return hasRecent ? null : <output className="nova-palette__outcome">{copy.noRecent}</output>;
  if (loading) return null;
  if (results.error) {
    return (
      <p className="nova-palette__outcome" role="alert">
        {results.error}
      </p>
    );
  }
  if (results.items.length === 0) return <output className="nova-palette__outcome">{copy.empty(text)}</output>;
  return results.truncated ? <p className="nova-palette__outcome">{copy.truncated}</p> : null;
}

export function QuickOpen({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={copy.title} size="md" className="nova-palette-dialog">
      {open ? <QuickOpenContent onClose={onClose} /> : null}
    </Dialog>
  );
}
