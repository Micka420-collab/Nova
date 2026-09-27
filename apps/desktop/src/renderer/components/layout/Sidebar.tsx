import { useEffect, useRef, useState } from "react";
import { Button, Callout, IconButton, Lockup, OrbitIndicator, Skeleton, TextField } from "@nova/ui";
import type { ConversationSummary } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeUiError } from "../../lib/errors";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { MOD_KEY } from "../../lib/platform";
import { useApp } from "../../state/context";
import { AlertIcon, HomeIcon, PencilIcon, PlusIcon, SettingsIcon, TrashIcon } from "../icons";
import { DeleteDialog, RenameDialog } from "./ConversationDialogs";
import { NomiDock } from "./NomiDock";

const SEARCH_DELAY_MS = 200;

type Pending = {
  kind: "rename" | "delete";
  conversation: ConversationSummary;
  /** Row that takes focus if this one disappears (next, else previous). */
  neighborId: string | null;
} | null;

function ConversationList({ onPending }: { onPending: (pending: Pending) => void }) {
  const conversations = useApp((state) => state.conversations);
  const status = useApp((state) => state.conversationsStatus);
  const error = useApp((state) => state.conversationsError);
  const query = useApp((state) => state.query);
  const activeId = useApp((state) => (state.ui.route === "chat" ? state.activeId : null));
  const streams = useApp((state) => state.streams);
  const failed = useApp((state) => state.failed);
  const hasMore = useApp((state) => state.conversationsHasMore);
  const openConversation = useApp((state) => state.openConversation);
  const refresh = useApp((state) => state.refreshConversations);
  const now = useNow(60_000);

  if (status === "error" && error) {
    return (
      <Callout
        tone="danger"
        title={fr.nav.loadFailed}
        action={
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            {fr.app.retry}
          </Button>
        }
      >
        <p>{describeUiError(error).title}</p>
      </Callout>
    );
  }
  if (status !== "ready") {
    return (
      <div className="nova-nav__loading" aria-busy="true">
        <p className="nv-visually-hidden">{fr.nav.loading}</p>
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
      </div>
    );
  }
  const searching = query.trim() !== "";
  if (conversations.length === 0) {
    return <p className="nova-nav__empty">{searching ? fr.nav.emptySearch(query.trim()) : fr.nav.empty}</p>;
  }
  const pending = (kind: "rename" | "delete", index: number, conversation: ConversationSummary) =>
    onPending({
      kind,
      conversation,
      neighborId: (conversations[index + 1] ?? conversations[index - 1])?.id ?? null,
    });
  return (
    <>
      <ul className="nova-nav__list">
        {conversations.map((item, index) => (
          <li key={item.id} className="nova-conv">
            <button
              type="button"
              className="nova-conv__open"
              data-conversation-id={item.id}
              aria-current={item.id === activeId ? "page" : undefined}
              onClick={() => openConversation(item.id)}
            >
              <span className="nova-conv__title">
                {streams[item.id] ? <OrbitIndicator active size={12} label={fr.nav.streaming} /> : null}
                {!streams[item.id] && failed[item.id] ? (
                  <span className="nova-conv__failed" title={fr.nav.failedMarker}>
                    <AlertIcon size={12} />
                    <span className="nv-visually-hidden">{fr.nav.failedMarker}</span>
                  </span>
                ) : null}
                <span className="nova-conv__title-text">{item.title}</span>
              </span>
              <span className="nova-conv__meta">{formatRelative(item.updatedAt, now)}</span>
            </button>
            <span className="nova-conv__actions">
              <IconButton
                aria-label={fr.nav.renameNamed(item.title)}
                icon={<PencilIcon size={14} />}
                size="sm"
                onClick={() => pending("rename", index, item)}
              />
              <IconButton
                aria-label={fr.nav.removeNamed(item.title)}
                icon={<TrashIcon size={14} />}
                size="sm"
                onClick={() => pending("delete", index, item)}
              />
            </span>
          </li>
        ))}
      </ul>
      {hasMore ? <p className="nova-nav__more">{searching ? fr.nav.moreResults : fr.nav.olderExist}</p> : null}
    </>
  );
}

export function Sidebar() {
  const route = useApp((state) => state.ui.route);
  const query = useApp((state) => state.query);
  const setQuery = useApp((state) => state.setQuery);
  const newConversation = useApp((state) => state.newConversation);
  const goHome = useApp((state) => state.goHome);
  const openSettings = useApp((state) => state.openSettings);
  const [search, setSearch] = useState(query);
  const [pending, setPending] = useState<Pending>(null);
  const middle = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search, query, setQuery]);

  return (
    <div className="nova-nav">
      <div className="nova-nav__top">
        <Lockup height={22} className="nova-nav__logo" />
        <Button
          variant="primary"
          icon={<PlusIcon />}
          onClick={newConversation}
          className="nova-nav__new"
          title={`${fr.nav.newConversation} (${MOD_KEY}+N)`}
          aria-keyshortcuts="Control+N Meta+N"
        >
          {fr.nav.newConversation}
        </Button>
        <TextField
          label={fr.nav.searchLabel}
          hideLabel
          type="search"
          placeholder={fr.nav.searchPlaceholder}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="nova-nav__middle" ref={middle}>
        <button type="button" className="nova-nav__link" aria-current={route === "home" ? "page" : undefined} onClick={goHome}>
          <HomeIcon />
          <span>{fr.nav.home}</span>
        </button>
        <h2 className="nova-nav__heading" ref={heading} tabIndex={-1}>
          {fr.nav.conversationsHeading}
        </h2>
        <ConversationList onPending={setPending} />
      </div>
      <div className="nova-nav__bottom">
        <button
          type="button"
          className="nova-nav__link"
          aria-current={route === "settings" ? "page" : undefined}
          onClick={() => openSettings()}
        >
          <SettingsIcon />
          <span>{fr.nav.settings}</span>
        </button>
        <NomiDock />
      </div>
      {pending?.kind === "rename" ? (
        <RenameDialog conversation={pending.conversation} onClose={() => setPending(null)} />
      ) : null}
      {pending?.kind === "delete" ? (
        <DeleteDialog
          conversation={pending.conversation}
          onClose={() => setPending(null)}
          returnFocus={() => {
            const { neighborId } = pending;
            const row = neighborId
              ? middle.current?.querySelector<HTMLElement>(`[data-conversation-id="${neighborId}"]`)
              : null;
            return row ?? heading.current;
          }}
        />
      ) : null}
    </div>
  );
}
