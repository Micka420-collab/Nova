// Project search panel (Ctrl/Cmd+Shift+F, FEATURES E4): ripgrep results grouped by file, and
// replace with a preview. Replacements go through files.write with the hash just read, so a file
// changed in the meantime is never overwritten; files with unsaved editor edits are skipped.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Callout, IconButton } from "@nova/ui";
import type { SearchMatch, SearchResult } from "@nova/shared";
import { describeUiError, toUiError } from "../../lib/errors";
import { ChevronDownIcon, CloseIcon } from "../icons";
import { useAtelier, useAtelierClient, useAtelierStore } from "../editor/atelier-context";
import { projectSearchCopy as copy } from "./search-copy";
import {
  buildSearchRegExp,
  groupMatches,
  parseGlobList,
  previewLine,
  replaceInText,
  type MatchGroup,
  type SearchOptions,
} from "./search-model";
// oxlint-disable-next-line import/no-unassigned-import -- side-effect stylesheet (extracted to a file by Vite)
import "./search.css";

const SEARCH_DELAY_MS = 300;
const MAX_RESULTS = 2_000;

type SearchState =
  | { status: "idle" }
  | { status: "searching"; pattern: string }
  | { status: "invalid"; error: string }
  | { status: "done"; pattern: string; result: SearchResult; groups: MatchGroup[] }
  | { status: "error"; error: string };

interface ReplaceOutcome {
  replacements: number;
  files: number;
  notes: string[];
}

interface Query extends SearchOptions {
  include: string[];
  exclude: string[];
}

function buildQuery(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
  wholeWord: boolean,
  include: string,
  exclude: string,
): Query {
  return { pattern, isRegex, caseSensitive, wholeWord, include: parseGlobList(include), exclude: parseGlobList(exclude) };
}

function HighlightedLine({ match }: { match: SearchMatch }) {
  const parts: (string | { hit: string })[] = [];
  let cursor = 0;
  for (const range of [...match.ranges].sort((a, b) => a.start - b.start)) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push(match.lineText.slice(cursor, range.start));
    parts.push({ hit: match.lineText.slice(range.start, range.end) });
    cursor = range.end;
  }
  if (cursor < match.lineText.length) parts.push(match.lineText.slice(cursor));
  return (
    <span className="nv-search__text">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- segments of one immutable line
          <mark key={index} className="nv-search-hit">
            {part.hit}
          </mark>
        ),
      )}
    </span>
  );
}

function Toggle({ label, glyph, pressed, onToggle }: { label: string; glyph: string; pressed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="nv-search__toggle"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onToggle}
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}

export function ProjectSearch({ onClose }: { onClose?: () => void }) {
  const client = useAtelierClient();
  const store = useAtelierStore();
  const workspaceId = useAtelier((state) => state.explorer.workspaceId);
  const tabs = useAtelier((state) => state.editor.tabs);

  const [pattern, setPattern] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [replacement, setReplacement] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<ReplaceOutcome | null>(null);
  const requestSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = buildQuery(pattern, isRegex, caseSensitive, wholeWord, include, exclude);

  const runSearch = useCallback(
    (next: Query) => {
      const seq = ++requestSeq.current;
      if (!workspaceId || next.pattern === "") {
        setSearch({ status: "idle" });
        return;
      }
      const built = buildSearchRegExp(next);
      if (!built.ok) {
        setSearch({ status: "invalid", error: copy.invalidRegex(built.error) });
        return;
      }
      setSearch({ status: "searching", pattern: next.pattern });
      client.search
        .text({ workspaceId, ...next, maxResults: MAX_RESULTS })
        .then((result) => {
          if (seq !== requestSeq.current) return;
          setSearch({ status: "done", pattern: next.pattern, result, groups: groupMatches(result.matches) });
        })
        .catch((error: unknown) => {
          if (seq === requestSeq.current) setSearch({ status: "error", error: describeUiError(toUiError(error)).title });
        });
    },
    [client, workspaceId],
  );

  useEffect(() => {
    const next = buildQuery(pattern, isRegex, caseSensitive, wholeWord, include, exclude);
    timer.current = setTimeout(() => {
      timer.current = null;
      runSearch(next);
    }, SEARCH_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [pattern, isRegex, caseSensitive, wholeWord, include, exclude, runSearch]);

  const searchNow = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    runSearch(query);
  };

  const dirty = new Set(tabs.filter((tab) => tab.dirty).map((tab) => tab.path));
  const groups = search.status === "done" ? search.groups : [];
  const targets = groups.filter((group) => !unchecked.has(group.path) && !dirty.has(group.path));
  const built = buildSearchRegExp(query);
  const regex = built.ok ? built.regex : null;

  const openMatch = (match: SearchMatch) => {
    const range = match.ranges[0];
    void store
      .getState()
      .editor.openFile(match.path, { line: match.line, ...(range ? { from: range.start, to: range.end } : {}) });
  };

  const toggleSet = (set: ReadonlySet<string>, path: string): Set<string> => {
    const next = new Set(set);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  };

  const applyReplace = async () => {
    if (!workspaceId || !regex) return;
    setApplying(true);
    const result: ReplaceOutcome = { replacements: 0, files: 0, notes: [] };
    for (const group of groups) {
      if (unchecked.has(group.path)) continue;
      // Re-read the editor state at apply time: a buffer may have become dirty since the preview.
      const tab = store.getState().editor.tabs.find((item) => item.path === group.path);
      if (tab?.dirty) {
        result.notes.push(copy.skippedDirty(group.path));
        continue;
      }
      try {
        const file = await client.files.read({ workspaceId, path: group.path });
        if (file.content === null || file.binary || file.tooLarge) {
          result.notes.push(copy.skippedUnreadable(group.path));
          continue;
        }
        const replaced = replaceInText(file.content, regex, replacement, isRegex);
        if (replaced.count === 0) continue;
        const written = await client.files.write({
          workspaceId,
          path: group.path,
          content: replaced.text,
          expectedHash: file.hash,
        });
        if (written.status === "conflict") {
          result.notes.push(copy.skippedConflict(group.path));
          continue;
        }
        result.replacements += replaced.count;
        result.files += 1;
      } catch (error) {
        result.notes.push(copy.skippedError(group.path, describeUiError(toUiError(error)).title));
      }
    }
    setApplying(false);
    setOutcome(result);
    setPreviewOpen(false);
    searchNow();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      onClose();
    }
  };

  if (!workspaceId) {
    return (
      <section className="nv-search" aria-label={copy.region}>
        <p className="nv-search__hint">{copy.noWorkspace}</p>
      </section>
    );
  }

  const matchCount = search.status === "done" ? search.result.matches.length : 0;

  return (
    // The Escape handler only closes the panel: every control inside stays reachable by keyboard.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section className="nv-search" aria-label={copy.region} onKeyDown={onKeyDown}>
      <header className="nv-search__header">
        <h2 className="nv-search__title">{copy.title}</h2>
        {onClose ? (
          <IconButton aria-label={copy.close} icon={<CloseIcon size={16} />} size="sm" onClick={onClose} />
        ) : null}
      </header>
      <form
        className="nv-search__form"
        onSubmit={(event) => {
          event.preventDefault();
          searchNow();
        }}
      >
        <div className="nv-search__row">
          <input
            className="nv-field__control nv-search__input"
            aria-label={copy.pattern}
            placeholder={copy.pattern}
            value={pattern}
            autoFocus
            spellCheck={false}
            onChange={(event) => setPattern(event.target.value)}
          />
          <Toggle label={copy.caseSensitive} glyph="Aa" pressed={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} />
          <Toggle label={copy.wholeWord} glyph="ab" pressed={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
          <Toggle label={copy.regex} glyph=".*" pressed={isRegex} onToggle={() => setIsRegex((v) => !v)} />
        </div>
        <input
          className="nv-field__control nv-search__input"
          aria-label={copy.replace}
          placeholder={copy.replace}
          value={replacement}
          spellCheck={false}
          onChange={(event) => setReplacement(event.target.value)}
        />
        <input
          className="nv-field__control nv-search__input"
          aria-label={copy.include}
          placeholder={`${copy.include} (${copy.globPlaceholder})`}
          value={include}
          onChange={(event) => setInclude(event.target.value)}
        />
        <input
          className="nv-field__control nv-search__input"
          aria-label={copy.exclude}
          placeholder={copy.exclude}
          value={exclude}
          onChange={(event) => setExclude(event.target.value)}
        />
        {/* Enter in any field submits; the button keeps the action discoverable without a pointer. */}
        <button type="submit" className="nv-visually-hidden">
          {copy.title}
        </button>
      </form>

      <SearchStatus search={search} matchCount={matchCount} />

      {outcome ? (
        <Callout tone={outcome.files > 0 ? "success" : "info"} title={outcome.files > 0 ? copy.resultTitle(outcome.replacements, outcome.files) : copy.resultNone}>
          {outcome.notes.length > 0 ? (
            <ul className="nv-search__notes">
              {outcome.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </Callout>
      ) : null}

      {groups.length > 0 && replacement !== "" && regex ? (
        <div className="nv-search__replace-actions">
          <Button size="sm" variant="secondary" onClick={() => setPreviewOpen((open) => !open)}>
            {previewOpen ? copy.hidePreview : copy.preview}
          </Button>
          {previewOpen ? (
            <Button
              size="sm"
              variant="primary"
              loading={applying}
              disabled={targets.length === 0}
              onClick={() => void applyReplace()}
            >
              {applying ? copy.applying : copy.apply(targets.length)}
            </Button>
          ) : null}
        </div>
      ) : null}

      {previewOpen && regex ? (
        <ul className="nv-search__preview" aria-label={copy.preview}>
          {groups.map((group) => {
            const isDirty = dirty.has(group.path);
            return (
              <li key={group.path} className="nv-search__preview-file">
                <label className="nv-search__preview-head">
                  <input
                    type="checkbox"
                    aria-label={copy.includeFile(group.path)}
                    checked={!unchecked.has(group.path) && !isDirty}
                    disabled={isDirty}
                    onChange={() => setUnchecked((set) => toggleSet(set, group.path))}
                  />
                  <span className="nv-search__path">{group.path}</span>
                  {isDirty ? <span className="nv-search__warning">{copy.dirtySkipped}</span> : null}
                </label>
                <ul>
                  {group.matches.map((match) => (
                    <li key={match.line} className="nv-search__preview-line">
                      <span className="nv-search__line-number">{match.line}</span>
                      <del aria-label={copy.before}>{match.lineText}</del>
                      <ins aria-label={copy.after}>{previewLine(match.lineText, regex, replacement, isRegex)}</ins>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!previewOpen && groups.length > 0 ? (
        <ul className="nv-search__results" aria-label={copy.region}>
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.path);
            return (
              <li key={group.path} className="nv-search__group">
                <button
                  type="button"
                  className="nv-search__group-head"
                  aria-expanded={!isCollapsed}
                  aria-label={copy.groupLabel(group.path, group.matches.length)}
                  onClick={() => setCollapsed((set) => toggleSet(set, group.path))}
                >
                  <span className="nv-search__chevron" aria-hidden>
                    <ChevronDownIcon size={16} />
                  </span>
                  <span className="nv-search__path">{group.path}</span>
                  <span className="nv-search__count" aria-hidden>
                    {group.matches.length}
                  </span>
                </button>
                {isCollapsed ? null : (
                  <ul className="nv-search__lines">
                    {group.matches.map((match) => (
                      <li key={`${match.line}:${match.ranges[0]?.start ?? 0}`}>
                        <button
                          type="button"
                          className="nv-search__line"
                          aria-label={copy.lineLabel(match.line, match.lineText)}
                          onClick={() => openMatch(match)}
                        >
                          <span className="nv-search__line-number" aria-hidden>
                            {match.line}
                          </span>
                          <HighlightedLine match={match} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function SearchStatus({ search, matchCount }: { search: SearchState; matchCount: number }) {
  switch (search.status) {
    case "idle":
      return <p className="nv-search__hint">{copy.hint}</p>;
    case "searching":
      return (
        <output className="nv-search__status">{copy.searching}</output>
      );
    case "invalid":
    case "error":
      return (
        <p className="nv-search__error" role="alert">
          {search.error}
        </p>
      );
    case "done":
      return (
        <output className="nv-search__status">
          {matchCount === 0
            ? copy.empty(search.pattern)
            : copy.summary(matchCount, search.groups.length, search.result.truncated)}
        </output>
      );
  }
}
