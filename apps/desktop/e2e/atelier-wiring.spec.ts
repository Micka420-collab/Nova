// J2-A wiring on the built app: every atelier group answers from its real service in main (no
// `unavailable` stub left), through the real preload bridge, workers included (fs-worker with
// ripgrep, pty-host with node-pty). The folder picker is the only stub: main's dialog is replaced
// so the test chooses the folder.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchNova, makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { MOCK_KEYS, startMockOpenRouter, type MockOpenRouter } from "./mock-openrouter";

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter();
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "cart.ts"), "export function total(items: number[]) {\n  return items.length; // TODO sum\n}\n");
  writeFileSync(join(project, ".env"), "TOKEN=never-read\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "vitest run" } }));
});

test.afterEach(async () => {
  await nova?.app.close().catch(() => {});
  nova = null;
  await mock.close();
  removeDir(userDataDir);
  removeDir(project);
});

test("every atelier group is served by its real service", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { app, page } = nova;
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, project);

  // Through the UI: a key, then « Ouvrir un dossier… » on Home; the tree of the folder shows.
  await page.evaluate(async (apiKey) => {
    const saved = await window.novaBridge.connection.setKey({ providerId: "openrouter", apiKey, storage: "session" });
    if (!saved.ok) throw new Error(saved.error.message);
  }, MOCK_KEYS.valid);
  await page.reload();
  const folderCard = page.getByRole("region", { name: "Ouvrir un dossier" });
  await folderCard.getByRole("button", { name: "Ouvrir un dossier…" }).click();
  await expect(page.getByRole("treeitem", { name: /package\.json/ }).first()).toBeVisible();
  // Home now offers to reopen it later; nothing was sent anywhere.
  await expect(page.getByText("Rien n'a été envoyé.")).toBeVisible();

  const result = await page.evaluate(async () => {
    const bridge = window.novaBridge;
    const value = <T,>(settled: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
      if (!settled.ok) throw new Error(`refused: ${settled.error.code}`);
      return settled.value;
    };
    const [workspace] = value(await bridge.workspace.recent({ limit: 1 }));
    if (!workspace) throw new Error("no workspace");
    const workspaceId = workspace.id;
    value(await bridge.workspace.reopen({ workspaceId }));
    const list = value(await bridge.files.list({ workspaceId, path: "" }));
    const read = value(await bridge.files.read({ workspaceId, path: "src/cart.ts" }));
    const search = value(
      await bridge.search.text({
        workspaceId,
        pattern: "TODO",
        isRegex: false,
        caseSensitive: false,
        wholeWord: false,
        include: [],
        exclude: [],
        maxResults: 10,
      }),
    );
    const facts = value(await bridge.workspace.facts({ workspaceId, refresh: true }));
    const git = value(await bridge.git.status({ workspaceId }));
    const profile = value(await bridge.permissions.getProfile({ workspaceId }));
    const rules = value(await bridge.permissions.listRules({ workspaceId }));
    const audit = value(
      await bridge.audit.list({
        workspaceId,
        missionId: null,
        actor: null,
        action: null,
        decision: null,
        operation: null,
        since: null,
        until: null,
        beforeSeq: null,
        limit: 50,
      }),
    );
    const web = value(await bridge.web.getPolicy({ workspaceId: null }));
    const mcp = value(await bridge.mcp.list({ workspaceId }));
    const companion = value(await bridge.companion.state({ workspaceId }));
    const notices = value(await bridge.companion.notices());
    const checkpoints = value(await bridge.checkpoints.list({ workspaceId, missionId: null, limit: 10 }));
    const missions = value(await bridge.missions.list({ workspaceId, limit: 10 }));
    const approvals = value(await bridge.approvals.list({ workspaceId, missionId: null, status: null }));
    await bridge.workspace.setEditorState({
      workspaceId,
      state: { version: 1, tabs: [{ path: "src/cart.ts", pinned: false }], activePath: "src/cart.ts", scroll: {} },
    });
    const editor = value(await bridge.workspace.getEditorState({ workspaceId }));
    const terminal = value(await bridge.terminal.create({ workspaceId, cwd: "", cols: 80, rows: 24 }));
    const sessions = value(await bridge.terminal.list({ workspaceId }));
    await bridge.terminal.kill({ sessionId: terminal.id });
    return {
      workspace,
      names: list.map((entry) => entry.name).sort(),
      content: read.content,
      matches: search.matches.map((match) => `${match.path}:${match.line}`),
      packageName: facts.workspaceId === workspaceId,
      git: git.available,
      profile: profile.profile,
      isolation: profile.isolationLevel,
      rules: rules.length,
      auditIsArray: Array.isArray(audit),
      webDefault: web.defaultAction,
      mcp: mcp.length,
      companionSignals: companion.signals.length,
      notices: notices.length,
      checkpoints: checkpoints.length,
      missions: missions.items.length,
      approvals: approvals.length,
      editorActive: editor?.activePath ?? null,
      terminalListed: sessions.some((session) => session.id === terminal.id),
      terminalShell: terminal.shell,
    };
  });

  expect(result.workspace.name).toBe(project.split(/[\\/]/).at(-1));
  expect(result.names).toEqual([".env", "package.json", "src"]);
  expect(result.content).toContain("return items.length;");
  // ripgrep in the fs-worker; `.env` (C8) is never searched.
  expect(result.matches).toEqual(["src/cart.ts:2"]);
  expect(result).toMatchObject({
    packageName: true,
    git: false,
    profile: "assisted",
    isolation: "L0",
    rules: 0,
    auditIsArray: true,
    webDefault: "ask",
    mcp: 0,
    companionSignals: 0,
    notices: 0,
    checkpoints: 0,
    missions: 0,
    approvals: 0,
    editorActive: "src/cart.ts",
    terminalListed: true,
  });
  expect(result.terminalShell).not.toBe("");
});

test("a mission runs in the agent-runtime worker: plan, approval, edit, diff, review, audit", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { app, page } = nova;
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, project);

  const outcome = await page.evaluate(
    async ({ apiKey, modelId }) => {
      const bridge = window.novaBridge;
      const value = <T,>(settled: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
        if (!settled.ok) throw new Error(`refused: ${settled.error.code} ${settled.error.message}`);
        return settled.value;
      };
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      value(await bridge.connection.setKey({ providerId: "openrouter", apiKey, storage: "session" }));
      value(await bridge.models.catalog({ providerId: "openrouter", refresh: true }));
      const workspace = value(await bridge.workspace.open());
      if (!workspace) throw new Error("no workspace");
      const workspaceId = workspace.id;

      const plan = value(
        await bridge.missions.plan({ workspaceId, conversationId: null, goal: "[mission] Le total du panier est faux", mode: "fix", modelId, contract: null }),
      );
      const { contract } = plan;
      value(
        await bridge.missions.start({
          missionId: plan.mission.id,
          tasks: null,
          contract: {
            profile: contract.profile,
            allowedOperations: contract.allowedOperations,
            allowedHosts: contract.allowedHosts,
            webSearch: false,
            maxDurationMs: contract.maxDurationMs,
            budgetUsd: contract.budgetUsd,
          },
        }),
      );

      // Assisté asks before the write: answer « Autoriser une fois » when the card appears.
      const approved: string[] = [];
      let state = "running";
      for (let round = 0; round < 300; round += 1) {
        const pending = value(await bridge.approvals.list({ workspaceId, missionId: plan.mission.id, status: "pending" }));
        for (const approval of pending) {
          value(await bridge.approvals.decide({ approvalId: approval.id, decision: "approve", scope: "once" }));
          approved.push(approval.request.tool);
        }
        state = value(await bridge.missions.get({ missionId: plan.mission.id, afterSeq: 0 })).mission.state;
        if (["succeeded", "failed", "cancelled", "suspended"].includes(state)) break;
        await wait(100);
      }
      const detail = value(await bridge.missions.get({ missionId: plan.mission.id, afterSeq: 0 }));
      const edited = value(await bridge.files.read({ workspaceId, path: "src/cart.ts" })).content;
      const diff = value(await bridge.missions.diff({ missionId: plan.mission.id }));
      const audit = value(
        await bridge.audit.list({
          workspaceId,
          missionId: plan.mission.id,
          actor: null,
          action: null,
          decision: null,
          operation: null,
          since: null,
          until: null,
          beforeSeq: null,
          limit: 100,
        }),
      );
      const checkpoints = value(await bridge.checkpoints.list({ workspaceId, missionId: plan.mission.id, limit: 10 }));
      const review = value(
        await bridge.missions.review({ missionId: plan.mission.id, decisions: [{ path: "src/cart.ts", hunkIndex: 0, decision: "reverted" }] }),
      );
      const reverted = value(await bridge.files.read({ workspaceId, path: "src/cart.ts" })).content;
      return {
        state,
        failure: detail.events.find((event) => event.type === "mission.failed") ?? null,
        approved,
        edited,
        diffFiles: diff.files.map((file) => ({ path: file.path, change: file.change, missing: file.missing })),
        patch: diff.files[0]?.patch ?? "",
        auditActions: [...new Set(audit.map((entry) => entry.action))].sort(),
        checkpoints: checkpoints.length,
        spent: detail.budget.spentUsd,
        review,
        reverted,
      };
    },
    { apiKey: MOCK_KEYS.valid, modelId: "deepseek/deepseek-v4-flash" },
  );

  expect(outcome.failure).toBeNull();
  expect(outcome.state).toBe("succeeded");
  expect(outcome.approved).toEqual(["edit_file"]);
  expect(outcome.edited).toContain("return items.reduce((sum, price) => sum + price, 0);");
  expect(outcome.diffFiles).toEqual([{ path: "src/cart.ts", change: "modified", missing: null }]);
  expect(outcome.patch).toContain("+  return items.reduce((sum, price) => sum + price, 0);");
  expect(outcome.auditActions).toEqual(expect.arrayContaining(["approval.decided", "permission.decision", "tool.executed"]));
  expect(outcome.checkpoints).toBe(1);
  expect(outcome.spent).toBeGreaterThan(0);
  expect(outcome.review).toEqual({ applied: [{ path: "src/cart.ts", hunkIndex: 0, decision: "reverted" }], conflicts: [] });
  expect(outcome.reverted).toContain("return items.length; // TODO sum");
  // The key went to the provider from main only: every mission request carried it.
  expect(mock.requests.filter((request) => request.path === "/api/v1/chat/completions").length).toBeGreaterThanOrEqual(4);
});

test("a chat message carries its @file for that turn only; a sensitive file is refused", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { app, page } = nova;
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, project);
  const outcome = await page.evaluate(
    async ({ apiKey, modelId }) => {
      const bridge = window.novaBridge;
      await bridge.connection.setKey({ providerId: "openrouter", apiKey, storage: "session" });
      const opened = await bridge.workspace.open();
      if (!opened.ok || !opened.value) throw new Error("no workspace");
      const workspaceId = opened.value.id;
      const refused = await bridge.chat.send({
        conversationId: null,
        content: "Lis @.env",
        modelId,
        workspaceId,
        attachments: [{ kind: "file", path: ".env" }],
      });
      const sent = await bridge.chat.send({
        conversationId: null,
        content: "Explique @src/cart.ts",
        modelId,
        workspaceId,
        attachments: [{ kind: "file", path: "src/cart.ts" }],
      });
      const conversations = await bridge.conversations.list({});
      return { refused: refused.ok ? null : refused.error.code, sent: sent.ok, count: conversations.ok ? conversations.value.items.length : -1 };
    },
    { apiKey: MOCK_KEYS.valid, modelId: "deepseek/deepseek-v4-flash" },
  );
  expect(outcome).toEqual({ refused: "invalid_request", sent: true, count: 1 });
  await expect.poll(() => mock.requests.filter((request) => request.path === "/api/v1/chat/completions").length).toBe(1);
  const request = mock.requests.find((item) => item.path === "/api/v1/chat/completions");
  const text = JSON.stringify(request?.body);
  expect(text).toContain("Fichier src/cart.ts");
  expect(text).not.toContain("never-read");
});
