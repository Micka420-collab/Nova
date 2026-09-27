// Test helpers of the diff documents: a store with a workspace and a mission that edited files.
import { render } from "@testing-library/react";
import { createNovaClient, type GitStatus, type Mission, type MissionEvent, type Proof } from "@nova/shared";
import { Toaster } from "@nova/ui";
import type { ReactNode } from "react";
import { applyMissionEvent, type MissionView } from "../missions/timeline";
import { createAtelierFake, makeContract, makeWorkspace } from "../../test/atelier-fake";
import { createFakeBridge, testId, VALID_CONNECTION, type AtelierOverrides } from "../../test/fake-bridge";
import { AppProvider } from "../../state/context";
import { createAppStore, type DisplayMode } from "../../state/store";

export interface FileEdit {
  path: string;
  change: "created" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

export function missionWithEdits(workspaceId: string, edits: FileEdit[], proofs: Proof[] = []): MissionView {
  const mission: Mission = {
    id: testId(),
    workspaceId,
    conversationId: null,
    title: "Corriger le panier",
    goal: "Corriger le panier",
    mode: "fix",
    state: "succeeded",
    modelId: "vendor/model",
    createdAt: 1_000,
    startedAt: 1_100,
    endedAt: 1_900,
    updatedAt: 1_900,
  };
  let seq = 0;
  const base = () => ({ id: testId(), missionId: mission.id, seq: ++seq, at: 1_000 + seq });
  const events: MissionEvent[] = [{ ...base(), type: "mission.created", mission, contract: makeContract(workspaceId) }];
  for (const edit of edits) {
    const callId = testId();
    events.push({
      ...base(),
      type: "tool.requested",
      taskId: null,
      call: { id: callId, name: "edit_file", operation: "write", argumentsPreview: "{}", path: edit.path, host: null, argv: null },
    });
    events.push({
      ...base(),
      type: "tool.finished",
      callId,
      state: "succeeded",
      durationMs: 5,
      display: { kind: "file_change", change: edit.change, path: edit.path, fromPath: null, additions: edit.additions, deletions: edit.deletions, checkpointId: null },
    });
  }
  let view = events.reduce<MissionView | undefined>((current, event) => applyMissionEvent(current, event), undefined);
  if (!view) throw new Error("no view");
  view = { ...view, proofs };
  return view;
}

export function renderWithMission(options: {
  overrides?: (base: AtelierOverrides) => AtelierOverrides;
  edits: FileEdit[];
  displayMode?: DisplayMode;
  git?: boolean;
  proofs?: (missionId: string) => Proof[];
  ui: (missionId: string) => ReactNode;
}) {
  const workspace = makeWorkspace();
  const git: GitStatus =
    options.git === false
      ? { available: false }
      : { available: true, branch: "main", upstream: null, ahead: null, behind: null, entries: [], truncated: false };
  const atelier = createAtelierFake({ workspace, git });
  const overrides = options.overrides ? options.overrides(atelier.overrides) : atelier.overrides;
  const fake = createFakeBridge({ connection: VALID_CONNECTION, atelier: overrides });
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  let view = missionWithEdits(workspace.id, options.edits);
  if (options.proofs) view = { ...view, proofs: options.proofs(view.mission.id) };
  store.setState((state) => ({
    workspace: {
      ...state.workspace,
      current: workspace,
      status: "ready",
      git,
    },
    missions: { ...state.missions, views: { [view.mission.id]: view } },
    ui: { ...state.ui, displayMode: options.displayMode ?? "create" },
  }));
  const utils = render(
    <AppProvider store={store} client={client}>
      <Toaster>{options.ui(view.mission.id)}</Toaster>
    </AppProvider>,
  );
  return { ...utils, fake, store, view, atelier, workspace };
}
