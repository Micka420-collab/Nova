// Around the goal composer: the @-mention picker (C6 v1: files, folders, URLs), the « Web » toggle
// (W1) and the context inspector (C5 v1: what leaves, where to, roughly how big). The composer
// keeps its keys; the picker listens in the capture phase only while it is open.
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { IconButton } from "@nova/ui";
import { fr } from "../../copy/fr";
import { describeUiError, toUiError } from "../../lib/errors";
import { formatInteger } from "../../lib/format";
import { useApp, useClient } from "../../state/context";
import { selectedModelId } from "../../state/store";
import { findModel } from "../models/filter";
import { CloseIcon } from "../icons";
import { approxTokens, extractMentions, insertMention, mentionQuery, mentionSuggestions, mentionToken, removeMention, type Mention } from "./mentions";

const copy = fr.atelier.context;
const SEARCH_DELAY_MS = 120;

interface PickerResults {
  query: string;
  items: Mention[];
  error: string | null;
}

function mentionLabel(mention: Mention): string {
  switch (mention.kind) {
    case "file":
      return copy.mentionFile(mention.path);
    case "folder":
      return copy.mentionFolder(`${mention.path}/`);
    case "url":
      return copy.mentionUrl(mention.url);
  }
}

function mentionText(mention: Mention): string {
  return mention.kind === "url" ? mention.url : mention.kind === "folder" ? `${mention.path}/` : mention.path;
}

/** Picker state for the goal text: suggestions while an `@query` is typed at the end. */
export function useMentionPicker(goal: string, setGoal: (next: string) => void) {
  const client = useClient();
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const query = workspaceId ? mentionQuery(goal) : null;
  const [results, setResults] = useState<PickerResults | null>(null);
  // The highlighted row belongs to one query: typing more starts again at the first row.
  const [cursor, setCursor] = useState<{ query: string | null; index: number }>({ query: null, index: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (query === null || !workspaceId) return;
    let current = true;
    const timer = setTimeout(() => {
      client.search
        .files({ workspaceId, query, limit: 20 })
        .then((result) => {
          if (current) setResults({ query, items: mentionSuggestions(query, result.paths), error: null });
        })
        .catch((error: unknown) => {
          if (current) setResults({ query, items: [], error: describeUiError(toUiError(error)).title });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, query, workspaceId]);

  const open = query !== null && dismissed !== goal;
  const fresh = results !== null && results.query === query;
  const items = open && fresh ? results.items : [];
  const active = cursor.query === query ? Math.min(cursor.index, Math.max(items.length - 1, 0)) : 0;
  const status: string | null = !open ? null : !fresh ? copy.pickerSearching : results.error ? results.error : items.length === 0 ? copy.pickerEmpty : null;

  const pick = (mention: Mention) => {
    setGoal(insertMention(goal, mention));
    setDismissed(null);
  };

  /** Capture-phase keys: only while the picker shows choices; otherwise the composer keeps them. */
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(goal);
      return;
    }
    if (items.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : items.length - 1;
      setCursor({ query, index: (active + step) % items.length });
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
      const chosen = items[active];
      if (!chosen) return;
      event.preventDefault();
      event.stopPropagation();
      pick(chosen);
    }
  };

  return { open, items, active, status, pick, onKeyDownCapture };
}

/**
 * Suggestions under the goal. Focus stays in the text field (the picker is driven by its keys);
 * the highlighted choice is announced as text, and every row is also a button for the mouse.
 */
export function MentionPicker({ picker }: { picker: ReturnType<typeof useMentionPicker> }) {
  if (!picker.open) return null;
  const { items, active, status } = picker;
  const current = items[active];
  return (
    <div className="nova-mentions">
      {items.length > 0 ? (
        <ul className="nova-mentions__list" aria-label={copy.pickerLabel}>
          {items.map((mention, index) => (
            <li key={mentionToken(mention)}>
              <button
                type="button"
                tabIndex={-1}
                className="nova-mentions__item"
                aria-current={index === active ? "true" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => picker.pick(mention)}
              >
                <span className="nova-mentions__kind">{mention.kind === "url" ? "URL" : mention.kind === "folder" ? "/" : "@"}</span>
                <span className="nova-mentions__text">{mentionText(mention)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <output className="nova-mentions__status">
        {status ?? (current ? `${mentionLabel(current)} · ${copy.pickerHint}` : copy.pickerHint)}
      </output>
    </div>
  );
}

/** « Web » toggle of the goal composer: the contract sheet starts from this choice. */
export function WebToggle() {
  const value = useApp((state) => state.missions.webPreference);
  const setWebPreference = useApp((state) => state.setWebPreference);
  const on = value === true;
  return (
    <button
      type="button"
      className="nova-chip"
      aria-pressed={on}
      title={on ? copy.webOn : copy.webHint}
      onClick={() => setWebPreference(!on)}
    >
      {copy.webToggle}
    </button>
  );
}

/** C5 v1: what leaves with the goal, where to, and its approximate size. */
export function ContextInspector({
  goal,
  onGoalChange,
  target = "mission",
}: {
  goal: string;
  onGoalChange: (next: string) => void;
  /** `chat`: mentions and Web go with this message (Discuter); `mission`: the agent reads them under permissions. */
  target?: "mission" | "chat";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const modelId = useApp((state) => selectedModelId(state, state.activeId));
  const models = useApp((state) => state.catalog.data?.models);
  const retention = useApp((state) => state.settings?.privacy.providerDataCollection ?? "deny");
  const web = useApp((state) => state.missions.webPreference === true);
  const mentions = extractMentions(goal);
  const modelName = findModel(models, modelId)?.name ?? modelId ?? fr.app.unknown;
  return (
    <div className="nova-inspector">
      <div className="nova-inspector__bar">
        <button type="button" className="nova-chip" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {copy.inspectorToggle}
          {mentions.length > 0 ? ` · ${mentions.length}` : ""}
        </button>
        <WebToggle />
        <span className="nova-note">{copy.mentionHint}</span>
      </div>
      {open ? (
        <section id={id} className="nova-inspector__panel" aria-label={copy.inspectorTitle}>
          <h3 className="nova-agent__subtitle">{copy.inspectorTitle}</h3>
          <ul className="nova-inspector__facts">
            <li>{copy.destinationModel(modelName)}</li>
            <li>{retention === "deny" ? copy.retentionDeny : copy.retentionAllow}</li>
            <li>{copy.goalTokens(formatInteger(approxTokens(goal)))}</li>
            <li>{web ? (target === "chat" ? copy.webOnChat : copy.webOn) : copy.webOff}</li>
          </ul>
          <h4 className="nova-inspector__subtitle">{copy.mentionsLabel}</h4>
          {mentions.length > 0 ? (
            <>
              <ul className="nova-inspector__mentions">
                {mentions.map((mention) => {
                  const label = mentionLabel(mention);
                  return (
                    <li key={mentionToken(mention)}>
                      <code>{mentionToken(mention)}</code>
                      <IconButton
                        size="sm"
                        aria-label={copy.removeMention(label)}
                        icon={<CloseIcon size={12} />}
                        onClick={() => onGoalChange(removeMention(goal, mention))}
                      />
                    </li>
                  );
                })}
              </ul>
              <p className="nova-note">{target === "chat" ? copy.chatAttaches : copy.missionReads}</p>
            </>
          ) : (
            <p className="nova-note">{copy.noMention}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
