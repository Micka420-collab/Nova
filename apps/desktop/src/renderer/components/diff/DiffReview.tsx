// "Changements" document (A11, VISUAL.md §4.3, UX.md §5.7): the files a mission touched, with
// their proofs, kept or restored per file (Créer) or per hunk (Expert). Nothing is kept implicitly:
// decisions go to main (`missions.review`), which refuses to overwrite a file changed since.
import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DiffFile,
  DiffHunk,
  EmptyState,
  SegmentedControl,
  Skeleton,
  useToast,
  type BadgeTone,
  type DiffDecisionState,
} from "@nova/ui";
import type { Proof, ReviewDecision, ReviewDecisionKind } from "@nova/shared";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useApp, useClient } from "../../state/context";
import { missionFacts, proofsForFile, type FileTouch, type MissionView } from "../missions/timeline";
import {
  decidedCount,
  hasPendingMix,
  initialReview,
  reviewKey,
  reviewReducer,
  toReviewDecisions,
  type HunkDecision,
} from "./model";
import { hunkTargetLine, type DiffHunkData } from "./parse";
import { missionDiffSource, noDiffSource, type MissionDiffFile, type MissionDiffSource } from "./source";

// CodeMirror (merge view) loads only when a side-by-side view is shown.
const SideBySide = lazy(() => import("./SideBySide").then((module) => ({ default: module.SideBySide })));

const copy = fr.diff.review;
const NARROW_PX = 640;
const WIDE_PX = 1100;

type Load =
  | { status: "loading" }
  | { status: "ready"; files: MissionDiffFile[]; source: MissionDiffSource["kind"] }
  | { status: "error" };

/** A load answers one request key (files touched, source, attempt); an older answer means loading. */
type KeyedLoad = { key: string; load: Load };

interface Done {
  file: ReviewDecisionKind | null;
  hunks: Record<number, ReviewDecisionKind>;
}

/** Decisions already recorded (review.decided events) plus those applied in this session. */
function collectDone(decisions: readonly ReviewDecision[]): Record<string, Done> {
  const done: Record<string, Done> = {};
  for (const decision of decisions) {
    const entry = (done[decision.path] ??= { file: null, hunks: {} });
    if (decision.hunkIndex === null) {
      entry.file = decision.decision;
      entry.hunks = {};
    } else {
      entry.hunks[decision.hunkIndex] = decision.decision;
    }
  }
  return done;
}

function conflictKey(path: string, hunk: number | null): string {
  return `${path}#${hunk ?? "file"}`;
}

/** Proof pill: only a real recorded execution earns "passé" (never a check without a run). */
function proofBadge(proofs: Proof[]): { tone: BadgeTone; text: string; verified: boolean; summary: string | null } {
  const proof = proofs.find((item) => item.kind === "test") ?? proofs[0];
  if (!proof) return { tone: "neutral", text: copy.proofNone, verified: false, summary: null };
  const test = proof.kind === "test";
  if (proof.exitCode === 0) {
    return { tone: "jade", text: test ? copy.proofTestPassed : copy.proofCommandPassed, verified: true, summary: proof.summary };
  }
  return { tone: "danger", text: test ? copy.proofTestFailed : copy.proofCommandFailed, verified: false, summary: proof.summary };
}

function hunkRange(hunk: DiffHunkData): { start: number; end: number } {
  const start = hunk.newLines > 0 ? hunk.newStart : hunk.oldStart;
  const count = hunk.newLines > 0 ? hunk.newLines : hunk.oldLines;
  return { start, end: start + Math.max(count, 1) - 1 };
}

function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const initial = element.getBoundingClientRect().width;
    if (initial > 0) setWidth(initial);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function DiffReview({ missionId }: { missionId: string }) {
  const view = useApp((state) => state.missions.views[missionId]);
  if (!view) {
    return (
      <div className="nova-diff">
        <EmptyState title={copy.missionMissing} headingLevel={2} />
      </div>
    );
  }
  return <LoadedReview view={view} />;
}

function LoadedReview({ view }: { view: MissionView }) {
  const client = useClient();
  const toast = useToast();
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const expert = useApp((state) => state.ui.displayMode === "expert");
  const reviewMission = useApp((state) => state.reviewMission);
  const revealFile = useApp((state) => state.revealFile);
  const refreshGit = useApp((state) => state.refreshGit);
  const missionId = view.mission.id;
  const facts = useMemo(() => missionFacts(view), [view]);
  // Serialized so the diff reloads when the touched files change, not on every mission event.
  const touchedJson = JSON.stringify(facts.files);
  const [keyed, setKeyed] = useState<KeyedLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [review, dispatch] = useReducer(reviewReducer, [], initialReview);
  const [applied, setApplied] = useState<ReviewDecision[]>([]);
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmRevertAll, setConfirmRevertAll] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [announcement, setAnnouncement] = useState<{ text: string; at: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLElement>(null);
  const width = useWidth(root);
  const narrow = width !== null && width < NARROW_PX;
  const wide = width !== null && width > WIDE_PX;
  const requestKey = `${workspaceId ?? ""}|${attempt}|${touchedJson}`;
  const load: Load = keyed?.key === requestKey ? keyed.load : { status: "loading" };

  useEffect(() => {
    let current = true;
    const touched = JSON.parse(touchedJson) as FileTouch[];
    // The mission's own diff (its hunks are the ones the review reverts); no workspace, no diff.
    const source = workspaceId ? missionDiffSource(client) : noDiffSource;
    source
      .load(missionId, touched)
      .then((files) => {
        if (!current) return;
        setKeyed({ key: requestKey, load: { status: "ready", files, source: source.kind } });
        dispatch({ type: "reset", files: files.map((file) => ({ path: file.touch.path, hunks: file.diff?.hunks.length ?? 0 })) });
      })
      .catch(() => {
        if (current) setKeyed({ key: requestKey, load: { status: "error" } });
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, missionId, touchedJson, requestKey]);

  const done = useMemo(() => collectDone([...(view.review ?? []), ...applied]), [view.review, applied]);

  // Keep the current hunk visible (WCAG 2.4.11).
  const cursorId = `diff-${missionId}-${review.cursor.file}-${review.cursor.hunk}`;
  useEffect(() => {
    document.getElementById(cursorId)?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);

  const announce = (text: string) => setAnnouncement({ text, at: Date.now() });

  async function submit(decisions: ReviewDecision[]): Promise<boolean> {
    if (decisions.length === 0) return false;
    setBusy(true);
    try {
      const result = await reviewMission(missionId, decisions);
      setApplied((previous) => [...previous, ...result.applied]);
      setConflicts((previous) => {
        const next = new Set(previous);
        for (const item of result.applied) next.delete(conflictKey(item.path, item.hunkIndex));
        for (const item of result.conflicts) next.add(conflictKey(item.path, item.hunkIndex));
        return next;
      });
      // Applied decisions leave the local draft: what is shown now comes from main.
      for (const item of result.applied) {
        if (item.hunkIndex === null) dispatch({ type: "decideFile", path: item.path, decision: "pending" });
        else dispatch({ type: "decideAt", path: item.path, hunk: item.hunkIndex, decision: "pending" });
      }
      if (result.applied.length > 0) toast.show({ title: copy.applied(result.applied.length), tone: "success" });
      void refreshGit();
      return true;
    } catch (error) {
      toast.show(errorToast(error, copy.applyFailed));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (load.status === "loading") {
    return (
      <div className="nova-diff" ref={root} aria-busy="true">
        <p className="nv-visually-hidden">{copy.loading}</p>
        <Skeleton height={40} radius={12} />
        <Skeleton height={40} radius={12} />
        <Skeleton height={40} radius={12} />
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="nova-diff" ref={root}>
        <Callout
          tone="danger"
          title={copy.error}
          action={
            <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              {copy.recompute}
            </Button>
          }
        />
      </div>
    );
  }
  if (load.files.length === 0) {
    return (
      <div className="nova-diff" ref={root}>
        <EmptyState title={copy.empty} description={copy.emptyBody} headingLevel={2} />
      </div>
    );
  }

  const files = load.files;
  const additions = facts.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = facts.files.reduce((sum, file) => sum + file.deletions, 0);
  const localCount = decidedCount(review);
  const showHunks = expert && !narrow;

  const effective = (path: string, hunk: number | null): DiffDecisionState => {
    if (conflicts.has(conflictKey(path, hunk)) || conflicts.has(conflictKey(path, null))) return "conflict";
    const local = review.decisions[path]?.[hunk ?? 0];
    if (local && local !== "pending") return local;
    const entry = done[path];
    if (!entry) return "pending";
    if (hunk !== null && entry.hunks[hunk]) return entry.hunks[hunk];
    return entry.file ?? "pending";
  };

  const filePill = (file: MissionDiffFile): ReactNode => {
    const path = file.touch.path;
    const hunks = file.diff?.hunks.length ?? 0;
    if (conflicts.has(conflictKey(path, null))) return null;
    if (hunks <= 1) {
      const state = effective(path, hunks === 0 ? null : 0);
      if (state === "kept") return <Badge tone="jade">{copy.kept}</Badge>;
      if (state === "reverted") return <Badge tone="neutral">{copy.reverted}</Badge>;
      return null;
    }
    const states = Array.from({ length: hunks }, (_, index) => effective(path, index));
    const kept = states.filter((state) => state === "kept").length;
    const reverted = states.filter((state) => state === "reverted").length;
    if (kept === hunks) return <Badge tone="jade">{copy.kept}</Badge>;
    if (reverted === hunks) return <Badge tone="neutral">{copy.reverted}</Badge>;
    if (kept + reverted === 0) return null;
    return <Badge tone="amber">{copy.partial(kept, hunks)}</Badge>;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], .cm-editor")) return;
    const result = reviewKey(event);
    if (!result) return;
    const current = files[review.cursor.file];
    event.preventDefault();
    if (result.kind === "action") {
      if (result.action.type === "decide" && current && conflicts.has(conflictKey(current.touch.path, null))) return;
      if (result.action.type === "toggleSideBySide" && !wide) {
        announce(copy.sideBySideNarrow);
        return;
      }
      dispatch(result.action);
      if (result.action.type === "decide") {
        announce(result.action.decision === "kept" ? copy.announceKept : copy.announceReverted);
      }
      return;
    }
    if (result.kind === "open") {
      if (!current) return;
      const hunk = current.diff?.hunks[review.cursor.hunk];
      revealFile(current.touch.path, hunk ? hunkTargetLine(hunk) : null);
      return;
    }
    if (result.kind === "summary") {
      if (current) dispatch({ type: "toggleExpanded", path: current.touch.path });
      return;
    }
    if (hasPendingMix(review)) setConfirmLeave(true);
    else region.current?.blur();
  };

  return (
    <div className="nova-diff" ref={root}>
      <header className="nova-diff__header">
        <h2 className="nova-diff__title">{copy.header(files.length, additions, deletions, view.mission.title)}</h2>
        <p className="nova-diff__summary">{copy.summaryCreate(facts.created, facts.modified, facts.deleted)}</p>
        <div className="nova-diff__actions">
          {showHunks ? (
            <SegmentedControl
              label={copy.viewLabel}
              size="sm"
              value={review.sideBySide && wide ? "split" : "unified"}
              onChange={(value) => {
                if ((value === "split") !== review.sideBySide) dispatch({ type: "toggleSideBySide" });
              }}
              options={[
                { value: "unified", label: copy.unified },
                { value: "split", label: copy.sideBySide, disabled: !wide },
              ]}
            />
          ) : null}
          {localCount > 0 ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void submit(toReviewDecisions(review))}>
              {copy.apply(localCount)}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void submit(files.map((file) => ({ path: file.touch.path, hunkIndex: null, decision: "kept" })))}
          >
            {copy.keepAll}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRevertAll(true)}>
            {copy.revertAll}
          </Button>
        </div>
      </header>

      {load.source === "none" ? <Callout tone="info">{copy.noGit}</Callout> : null}
      {load.source === "git" ? <p className="nova-diff__note">{copy.gitNote}</p> : null}
      {narrow ? <Callout tone="info">{copy.narrow}</Callout> : null}
      {showHunks ? <p className="nova-diff__keys">{copy.keys}</p> : null}
      {showHunks && review.sideBySide && !wide ? <p className="nova-diff__note">{copy.sideBySideNarrow}</p> : null}

      {/* The review region owns single-letter keys only while it has focus (WCAG 2.1.4, POWER_UX §2.2). */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- focusable keyboard review surface */}
      <section ref={region} className="nova-diff__region" aria-label={copy.label} tabIndex={0} onKeyDown={onKeyDown}>
        {files.map((file, fileIndex) => {
          const path = file.touch.path;
          const proofs = proofBadge(proofsForFile(view, path));
          const hunks = file.diff?.hunks ?? [];
          const expanded = showHunks ? !review.expanded[path] : Boolean(review.expanded[path]);
          const isCurrent = review.cursor.file === fileIndex;
          const fileConflict = conflicts.has(conflictKey(path, null));
          const changeLabel = copy.change[file.touch.change];
          return (
            <DiffFile
              key={path}
              id={hunks.length === 0 ? `diff-${missionId}-${fileIndex}-0` : undefined}
              path={file.touch.fromPath && file.touch.change === "moved" ? copy.moved(file.touch.fromPath, path) : path}
              additions={file.touch.additions}
              deletions={file.touch.deletions}
              expanded={expanded && hunks.length > 0}
              onToggle={() => dispatch({ type: "toggleExpanded", path })}
              toggleLabel={copy.toggleFile(path, expanded)}
              current={isCurrent}
              proof={
                <span className="nova-diff__proof">
                  <span className="nova-diff__change">{changeLabel}</span>
                  <Badge tone={proofs.tone}>{proofs.text}</Badge>
                  {!showHunks ? (
                    <span className="nova-diff__verified">
                      {proofs.verified && proofs.summary ? copy.verifiedBy(proofs.summary) : copy.unverified}
                    </span>
                  ) : null}
                </span>
              }
              pill={filePill(file)}
              note={
                fileConflict ? (
                  <Callout tone="warning">{copy.conflict}</Callout>
                ) : file.missing && file.missing !== "no_git" ? (
                  <p className="nova-diff__note">{copy.missing[file.missing]}</p>
                ) : file.truncated ? (
                  <p className="nova-diff__note">{copy.truncated}</p>
                ) : null
              }
              actions={
                <>
                  {!showHunks && hunks.length > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "toggleExpanded", path })}>
                      {expanded ? copy.hide : copy.see}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void submit([{ path, hunkIndex: null, decision: "kept" }])}
                  >
                    {copy.keep}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void submit([{ path, hunkIndex: null, decision: "reverted" }])}
                  >
                    {file.touch.change === "created" ? copy.remove : copy.restore}
                  </Button>
                </>
              }
            >
              {isCurrent && review.sideBySide && wide && showHunks && file.diff && workspaceId ? (
                <Suspense fallback={<p className="nova-note">{fr.atelier.shell.viewLoading}</p>}>
                  <SideBySide workspaceId={workspaceId} file={file.diff} />
                </Suspense>
              ) : (
                hunks.map((hunk, hunkIndex) => {
                  const state = effective(path, hunkIndex);
                  const range = hunkRange(hunk);
                  const local: HunkDecision = review.decisions[path]?.[hunkIndex] ?? "pending";
                  return (
                    <DiffHunk
                      key={hunk.index}
                      id={`diff-${missionId}-${fileIndex}-${hunkIndex}`}
                      header={hunk.header}
                      context={hunk.context}
                      lines={hunk.lines}
                      decision={state}
                      current={isCurrent && review.cursor.hunk === hunkIndex}
                      regionLabel={copy.hunkRegion(hunkIndex + 1, hunks.length, range.start, range.end)}
                      lineLabels={{ add: copy.lineAdded, del: copy.lineRemoved }}
                      showMoreLabel={copy.showMore}
                      alwaysShowActions={expert}
                      decisionPill={
                        state === "kept" ? (
                          <Badge tone="jade">{copy.kept}</Badge>
                        ) : state === "reverted" ? (
                          <Badge tone="neutral">{copy.reverted}</Badge>
                        ) : null
                      }
                      conflict={state === "conflict" ? <Callout tone="warning">{copy.conflict}</Callout> : null}
                      actions={
                        showHunks && state !== "conflict" ? (
                          local === "pending" ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => dispatch({ type: "decideAt", path, hunk: hunkIndex, decision: "kept" })}
                              >
                                {copy.keepHunk}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => dispatch({ type: "decideAt", path, hunk: hunkIndex, decision: "reverted" })}
                              >
                                {copy.revertHunk}
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => dispatch({ type: "decideAt", path, hunk: hunkIndex, decision: "pending" })}
                            >
                              {copy.resetHunk}
                            </Button>
                          )
                        ) : null
                      }
                    />
                  );
                })
              )}
            </DiffFile>
          );
        })}
      </section>

      <output className="nv-visually-hidden" aria-live="polite">
        {announcement ? <span key={announcement.at}>{announcement.text}</span> : null}
      </output>

      <Dialog
        open={confirmRevertAll}
        onClose={() => setConfirmRevertAll(false)}
        title={copy.revertAllTitle}
        description={copy.revertAllBody}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRevertAll(false)}>
              {fr.app.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRevertAll(false);
                void submit(files.map((file) => ({ path: file.touch.path, hunkIndex: null, decision: "reverted" })));
              }}
            >
              {copy.revertAllConfirm}
            </Button>
          </>
        }
      >
        <ul className="nova-diff__confirm-list">
          {files.map((file) => (
            <li key={file.touch.path}>
              <code>{file.touch.path}</code> — {copy.change[file.touch.change]}
            </li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={copy.leaveTitle}
        description={copy.leaveBody}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
              {copy.leaveCancel}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmLeave(false);
                void submit(toReviewDecisions(review, "kept"));
              }}
            >
              {copy.leaveConfirm}
            </Button>
          </>
        }
      />
    </div>
  );
}
