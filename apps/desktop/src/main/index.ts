// NOVA main process: data directory, store, vault, provider, runtime, IPC, window.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Menu, MessageChannelMain, Notification, Tray, app, dialog, nativeImage, net, safeStorage, session, shell } from "electron";
import { COMPACTION_SUMMARY_MAX_TOKENS, ChatRunner, buildCompactionPrompt, normalizeCompactionSummary } from "@nova/agent-runtime";
import type { SystemNotification } from "@nova/companion";
import { detectIsolation } from "@nova/permissions";
import { OpenRouterProvider } from "@nova/providers";
import { DEFAULT_DAILY_BUDGET_USD, IPC_CHANNELS, type IpcChannel } from "@nova/shared";
import {
  createApprovalRepo,
  createAuditRepo,
  createCheckpointRepo,
  createEditorStateRepo,
  createMcpRepo,
  createMissionRepo,
  createPolicyRepo,
  createScheduleRepo,
  createSignalRepo,
  createSkillRepo,
  createSuggestionRepo,
  createWebCacheRepo,
  createWebPolicyRepo,
  createWebSearchUsageRepo,
  createWorkspaceRepo,
  openNovaStore,
  type NovaStore,
} from "@nova/storage";
import { createProcessCommandRunner, type ToolDeps } from "@nova/tools";
import { createOpenRouterWebSearcher, pickWebSearchModel } from "@nova/web";
import {
  createGitClient,
  createIgnoreMatcher,
  createObjectStore,
  createWorkspaceFileOps,
  createWorktreeManager,
  readBytesOrNull,
  resolveExisting,
} from "@nova/workspace";
import { openAgentRuntimePort } from "../workers/agent/main-port";
import { createMainApi } from "./api";
import { resolveRipgrepPath, workerSpecs } from "./native-deps";
import { SELFTEST_FLAG, runWorkerSelfTest } from "./selftest";
import { WorkerPool } from "./workers";
import { registerIpcRoutes } from "./ipc";
import { buildIpcRoutes } from "./ipc-routes";
import { createFileLogger, describeError, type Logger } from "./logger";
import { handleAppProtocol, registerAppScheme } from "./protocol";
import { hardenSession, hardenWebContents, isTrustedSender, type SecurityContext } from "./security";
import {
  CORRUPT_DATABASE_CHOICES,
  QUIT_CHOICE,
  RESET_CHOICE,
  classifyStoreOpenFailure,
  corruptDatabaseMessage,
  quarantineDatabase,
} from "./store-recovery";
import { APP_ENTRY_URL, resolveLaunchOverrides } from "./security-policy";
import { createDesktopPresence, type DesktopPresence } from "./desktop/presence";
import { QUIT_CANCEL, QUIT_CONFIRM } from "./desktop/quit-warning";
import { TRAY_ICON_DATA_URL, trayIconSize } from "./desktop/tray-icon";
import { createAppService } from "./services/app-service";
import { createChainService } from "./services/chain-service";
import { createContextService } from "./services/context-service";
import { createAutopilotService } from "./services/autopilot-service";
import { createDesktopService, type DesktopService } from "./services/desktop-service";
import { ApprovalsService } from "./services/approvals-service";
import { AuditService } from "./services/audit-service";
import { CatalogService } from "./services/catalog-service";
import { createChatContext } from "./services/chat-context";
import { ChatEventHub } from "./services/chat-events";
import { checkpointObjectsDir, createCheckpointsService } from "./services/checkpoints-service";
import { createCompanionService, type CompanionService } from "./services/companion-service";
import { ConnectionService } from "./services/connection-service";
import { createFilesService } from "./services/files-service";
import { createGitService } from "./services/git-service";
import { unavailableHarnessApi } from "./services/harness-unavailable";
import { McpService } from "./services/mcp-service";
import { createMissionsService, createReviewFsGate, type MissionsService } from "./services/missions-service";
import { PermissionsService } from "./services/permissions-service";
import { createProcessesService } from "./services/processes-service";
import { createSchedulesService, type SchedulesService } from "./services/schedules-service";
import { createSearchService } from "./services/search-service";
import { createSkillsService } from "./services/skills-service";
import { createSubmissionsService, type SubmissionsService } from "./services/submissions-service";
import { createTerminalService } from "./services/terminal-service";
import { createTimelineService } from "./services/timeline-service";
import { WebService } from "./services/web-service";
import { createWorkspaceService } from "./services/workspace-service";
import { createElectronVault } from "./vault";

const APP_NAME = "NOVA";
const APP_USER_MODEL_ID = "io.github.micka420collab.nova";
/** Longest wait at quit for generations to persist their stopped state. */
const QUIT_IDLE_TIMEOUT_MS = 3_000;

const overrides = resolveLaunchOverrides(app.isPackaged, process.env);
const devOrigin = overrides.rendererDevUrl ? new URL(overrides.rendererDevUrl).origin : null;

// Order matters: the data dir decides the single-instance lock, and schemes must exist before ready.
app.setName(APP_NAME);
if (overrides.userDataDir) app.setPath("userData", overrides.userDataDir);
app.enableSandbox();
registerAppScheme();

let mainWindow: BrowserWindow | null = null;
/** J2-B L7: tray, close behavior and quit question (created once the services exist). */
let presence: DesktopPresence | null = null;
let desktop: DesktopService | null = null;
/** A quit waits for the window to close (its unsaved-edits guard may cancel it), then resumes. */
let quitAfterClose = false;
/** J2-B L7: the user answered the quit question (or nothing ran). */
let quitConfirmed = false;

/** Buttons of the unsaved-edits question (index = returned choice). */
const UNSAVED_CHOICES = ["Annuler", "Continuer sans enregistrer"] as const;
const UNSAVED_CANCEL = 0;

function createWindow(context: SecurityContext): BrowserWindow {
  const icon = join(app.getAppPath(), "build", "icon.png");
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#111619",
    title: APP_NAME,
    show: false,
    ...(process.platform === "linux" && existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.on("render-process-gone", (_event, details) => {
    const data = { reason: details.reason, exitCode: details.exitCode };
    if (details.reason === "clean-exit") context.logger.info("renderer process exited", data);
    else context.logger.error("renderer process gone", data);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    context.logger.error("renderer failed to load", { code, description });
    // ready-to-show may never fire: an error page beats an invisible running app.
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  });
  // The renderer holds a quit, a close or a reload while a buffer has unsaved edits (beforeunload):
  // ask here, where nothing can be lost silently. Cancel keeps the window and aborts the quit.
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: APP_NAME,
      message: "Des fichiers ont des modifications non enregistrées.",
      detail: "Si tu continues, elles seront perdues. Annule pour les enregistrer (Ctrl+S dans l'éditeur).",
      buttons: [...UNSAVED_CHOICES],
      defaultId: UNSAVED_CANCEL,
      cancelId: UNSAVED_CANCEL,
      noLink: true,
    });
    if (choice === UNSAVED_CANCEL) {
      quitAfterClose = false;
      // J2-B L7: the quit is off; the next quit asks again and closing follows the setting.
      quitConfirmed = false;
      presence?.setQuitting(false);
    } else event.preventDefault();
  });
  presence?.attachWindow(window);
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    if (quitAfterClose) app.quit();
  });
  const url = overrides.rendererDevUrl ?? APP_ENTRY_URL;
  window.loadURL(url).catch((error: unknown) => {
    context.logger.error("renderer load rejected", { error: describeError(error) });
  });
  return window;
}

/** main → renderer push (a closed window just drops it). */
function push(channel: IpcChannel, payload: unknown): void {
  const window = mainWindow;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
}

/** P13: at most one visible system notification per group; clicking it brings NOVA back. */
function createNotifier(): (notification: SystemNotification) => void {
  const shown = new Map<string, Notification>();
  return (notification) => {
    if (!Notification.isSupported()) return;
    if (notification.replacesGroup) shown.get(notification.groupKey)?.close();
    const native = new Notification({ title: APP_NAME, body: notification.body, silent: true });
    native.on("click", () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    });
    native.on("close", () => {
      if (shown.get(notification.groupKey) === native) shown.delete(notification.groupKey);
    });
    shown.set(notification.groupKey, native);
    native.show();
  };
}

/** Supervised utilityProcess workers; each starts on first use (nothing runs until a feature needs it). */
async function createWorkerPool(logger: Logger): Promise<WorkerPool> {
  const ripgrepPath = await resolveRipgrepPath().catch((error: unknown) => {
    logger.error("ripgrep not found", { error: describeError(error) });
    return null;
  });
  return new WorkerPool(workerSpecs(import.meta.dirname, { ripgrepPath }), { logger });
}

/** Opens the store; on failure explains it and, for a damaged file, offers to set it aside. */
function openStore(dataDir: string, logger: Logger): NovaStore | null {
  const databasePath = join(dataDir, "nova.sqlite");
  try {
    mkdirSync(dataDir, { recursive: true });
    return openNovaStore(databasePath);
  } catch (error) {
    logger.error("store open failed", { error: describeError(error) });
    const failure = classifyStoreOpenFailure(error);
    if (failure === "newer_schema") {
      dialog.showErrorBox(
        "Mise à jour de NOVA nécessaire",
        "Vos données ont été enregistrées par une version plus récente de NOVA. Installez la dernière version pour les ouvrir. Elles n'ont pas été modifiées.",
      );
      return null;
    }
    if (failure === "corrupt") return recoverCorruptStore(databasePath, logger);
    dialog.showErrorBox(
      "NOVA ne peut pas démarrer",
      `La base de données locale (${databasePath}) n'a pas pu être ouverte. Détails dans le journal : ${logger.file}`,
    );
    return null;
  }
}

/** Nothing is renamed without the user's explicit choice; a second failure is reported, not retried. */
function recoverCorruptStore(databasePath: string, logger: Logger): NovaStore | null {
  const choice = dialog.showMessageBoxSync({
    type: "error",
    ...corruptDatabaseMessage(databasePath),
    buttons: [...CORRUPT_DATABASE_CHOICES],
    defaultId: QUIT_CHOICE,
    cancelId: QUIT_CHOICE,
    noLink: true,
  });
  if (choice !== RESET_CHOICE) return null;
  try {
    const moved = quarantineDatabase(databasePath, new Date());
    logger.warn("damaged database set aside", { files: moved });
    return openNovaStore(databasePath);
  } catch (error) {
    logger.error("store reset failed", { error: describeError(error) });
    dialog.showErrorBox(
      "NOVA ne peut pas démarrer",
      `La base de données (${databasePath}) n'a pas pu être remplacée. Détails dans le journal : ${logger.file}`,
    );
    return null;
  }
}

async function start(logger: Logger, dataDir: string, logDir: string): Promise<void> {
  await app.whenReady();
  const store = openStore(dataDir, logger);
  if (!store) {
    app.exit(1);
    return;
  }
  logger.info("store opened", { interruptedStreams: store.markInterruptedStreams() });

  const workers = await createWorkerPool(logger);
  const context: SecurityContext = { devOrigin, logger };
  hardenSession(session.defaultSession, context);
  handleAppProtocol(join(import.meta.dirname, "../renderer"));

  const vault = createElectronVault(safeStorage, process.platform);
  const provider = new OpenRouterProvider({
    ...(overrides.openRouterBaseUrl ? { baseUrl: overrides.openRouterBaseUrl } : {}),
    // Chromium networking: system proxy and certificate store, like a browser.
    fetch: (url, init) => net.fetch(url, init),
  });
  const connections = new ConnectionService({ store, vault, provider, logger });
  // The key in use, known to the web exfiltration guard (compared, never logged).
  let knownKey: string | null = null;
  const resolveApiKey = async (): Promise<string | null> => {
    knownKey = await connections.resolveApiKey();
    return knownKey;
  };
  const catalog = new CatalogService({ store, provider, resolveApiKey, logger });

  // J2-A atelier ------------------------------------------------------------
  // Late-bound: the companion, missions and approvals reference each other only through events.
  let companion: CompanionService | null = null;
  let missions: MissionsService | null = null;
  // J2-B late-bound lanes: sub-missions and schedules follow mission events once they exist.
  let submissions: SubmissionsService | null = null;
  let schedules: SchedulesService | null = null;
  const missionsController = () => {
    if (!missions) throw new Error("missions not ready");
    return missions.controller;
  };

  const workspaceRepo = createWorkspaceRepo(store.db);
  const gitClient = createGitClient();
  const rgPath = await resolveRipgrepPath().catch(() => null);
  const workspaceService = createWorkspaceService({
    repo: workspaceRepo,
    editorState: createEditorStateRepo(store.db),
    homeDir: app.getPath("home"),
    git: gitClient,
    worker: {
      request: (method, params) => workers.get("fs-worker").request(method, params),
      onNotify: (listener) => workers.instance("fs-worker").onNotify(listener),
      onExit: (listener) => workers.instance("fs-worker").onExit(listener),
    },
    pickFolder: async () => {
      const options = { properties: ["openDirectory" as const] };
      const picked = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
  });
  const checkpointsService = createCheckpointsService({
    workspaces: workspaceService,
    index: createCheckpointRepo(store.db),
    dataDir,
  });
  const filesService = createFilesService({
    workspaces: workspaceService,
    trashItem: (path) => shell.trashItem(path),
    checkpoints: checkpointsService.store,
    rgPath,
  });
  filesService.onEvent((event) => push(IPC_CHANNELS.filesEvent, event));
  const searchService = createSearchService({ workspaces: workspaceService });
  const gitService = createGitService({ workspaces: workspaceService, git: gitClient });

  const audit = new AuditService({ repo: createAuditRepo(store.db) });
  const policies = createPolicyRepo(store.db);
  const isolation = await detectIsolation();
  const permissions = new PermissionsService({
    policies,
    audit,
    isolation,
    contractOf: (missionId) => missions?.controller.contractOf(missionId) ?? null,
    rootOf: (workspaceId) => workspaceService.rootOf(workspaceId).catch(() => null),
    // J2-B L5: a writing sub-mission's paths resolve in its worktree, where its tools act.
    missionRootOf: (missionId) => submissions?.controller.workspaceRootOf(missionId) ?? Promise.resolve(null),
    knownCommands: (workspaceId) => {
      const facts = workspaceRepo.getFacts(workspaceId);
      return [facts?.testRunner?.command, facts?.buildCommand].filter((command): command is string[] => !!command);
    },
  });
  const approvals = new ApprovalsService({
    approvals: createApprovalRepo(store.db),
    policies,
    audit,
    emit: (event) => {
      missions?.onApprovalEvent(event);
      push(IPC_CHANNELS.approvalsEvent, event);
      desktop?.notify();
    },
  });

  const web = new WebService({
    policies: createWebPolicyRepo(store.db),
    audit,
    cache: createWebCacheRepo(store.db),
    usage: createWebSearchUsageRepo(store.db),
    providerId: provider.id,
    // `mcp` is created below; the guard only runs on requests, after startup.
    knownSecrets: () => [...(knownKey ? [knownKey] : []), ...mcp.knownSecrets()],
    searcher: createOpenRouterWebSearcher({
      apiKey: resolveApiKey,
      selectModel: async () => pickWebSearchModel((await catalog.catalog({ refresh: false })).models)?.id ?? null,
      dataCollection: () => store.getSettings().privacy.providerDataCollection,
      fetch: (url, init) => net.fetch(url, init),
      ...(overrides.openRouterBaseUrl ? { baseUrl: overrides.openRouterBaseUrl } : {}),
    }),
    logger,
  });
  const mcp = new McpService({
    repo: createMcpRepo(store.db),
    audit,
    secrets: store,
    vault,
    host: workers.instance("mcp-host"),
    workspaceRoot: (workspaceId) => workspaceRepo.get(workspaceId)?.rootPath ?? null,
    knownSecrets: () => (knownKey ? [knownKey] : []),
    logger,
  });

  const terminal = createTerminalService({
    worker: () => workers.get("pty-host"),
    workspaceRoot: (workspaceId) => workspaceService.rootOf(workspaceId).catch(() => null),
    sendPort: (envelope, port) => {
      const window = mainWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
      window.webContents.postMessage(IPC_CHANNELS.portTransfer, envelope, [port]);
      return true;
    },
    createChannel: () => new MessageChannelMain(),
  });
  terminal.onEvent((event) => {
    push(IPC_CHANNELS.terminalEvent, event);
    desktop?.notify();
  });
  terminal.onExit((ended, outputTail) =>
    companion?.onProcessExit({ sessionId: ended.id, exitCode: ended.exitCode, signal: null, outputTail }),
  );

  // Agent tools run in main under the permission engine (L0: no shell, confined cwd, scrubbed env).
  // J2-B L1: background processes run in read-only agent terminals; foreground ones are mirrored.
  const processes = createProcessesService({
    resolveCwd: async (workspaceId, cwd) => {
      try {
        return await resolveExisting(await workspaceService.rootOf(workspaceId), cwd);
      } catch {
        return null;
      }
    },
    terminal,
    // Late-bound: a process only ends after a mission started it.
    journal: { append: (event) => missions?.controller.journal.append(event) },
    mirrorTitle: "Commandes de Nomi",
    logger,
  });
  processes.onEvent((event) => {
    push(IPC_CHANNELS.processesEvent, event);
    desktop?.notify();
  });

  // J2-B L3: skills (builtin, user under <dataDir>/skills, project under .nova/skills).
  const skills = createSkillsService({
    skillsDir: join(dataDir, "skills"),
    repo: createSkillRepo(store.db),
    rootOf: (workspaceId) => workspaceService.rootOf(workspaceId),
    pickFolder: async () => {
      const options = { properties: ["openDirectory" as const] };
      const picked = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    logger,
  });
  await skills.init();

  // J2-B L4: one isolated chain-host per program (outside the WorkerPool).
  const chain = createChainService({ entry: join(import.meta.dirname, "workers", "chain-host.js"), logger });

  const objects = createObjectStore(checkpointObjectsDir(dataDir));
  const toolDeps = async (workspaceId: string): Promise<ToolDeps> => ({
    files: await filesService.fileOpsFor(workspaceId),
    facts: () => workspaceService.api.facts({ workspaceId, refresh: false }).catch(() => null),
    commands: processes.runner,
    git: { status: gitService.api.status, diff: gitService.api.diff, commit: gitService.commit },
    web,
    mcp,
    processes: processes.tools,
    skills: skills.tools,
    chain,
  });

  // J2-B L2: context gauge, compaction proposals and model handoff (logic in main).
  const missionsProxy = () => {
    if (!missions) throw new Error("missions not ready");
    return missions.host.proxy;
  };
  const contextService = createContextService({
    store,
    provider,
    resolveApiKey,
    missions: () => {
      const ready = missionsController();
      return { isRunning: (id) => ready.isRunning(id), journal: ready.journal, proxy: missionsProxy() };
    },
    push: (event) => push(IPC_CHANNELS.contextEvent, event),
    prompt: buildCompactionPrompt,
    normalize: normalizeCompactionSummary,
    summaryMaxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
    logger,
  });
  // J2-B L8: « jusqu'à preuve » rounds, timeline search and fork.
  const timeline = createTimelineService({ store, missions: missionsController });
  missions = createMissionsService({
    store,
    provider,
    resolveApiKey,
    push: (event) => {
      push(IPC_CHANNELS.missionsEvent, event);
      companion?.onMissionEvent(event);
      submissions?.controller.onMissionEvent(event);
      schedules?.onMissionEvent(event);
      desktop?.notify();
    },
    toolDeps,
    skillIndex: (workspaceId) => skills.skillIndex(workspaceId),
    contextHook: contextService.runtimeHook,
    continuation: { hook: timeline.continuation, beforeTerminal: (event) => timeline.beforeRuntimeEvent(event) },
    routeToolDeps: (workspaceId, missionId, base) =>
      submissions ? submissions.toolDepsFor(workspaceId, missionId, base) : Promise.resolve(base),
    stopMissionProcesses: (missionId) => submissions?.stopAll(missionId) ?? Promise.resolve(),
    missionRootOf: (missionId) => submissions?.controller.workspaceRootOf(missionId) ?? Promise.resolve(null),
    mcpTools: (workspaceId) => mcp.listToolsForModel(workspaceId),
    permissions: { evaluate: (request, options) => permissions.evaluateOnDisk(request, options) },
    approvals,
    checkpoints: {
      create: (input) => checkpointsService.store.create(input),
      list: (req) => checkpointsService.api.list(req),
    },
    reviewFs: createReviewFsGate({
      rootOf: (workspaceId) => workspaceService.rootOf(workspaceId),
      restoreFile: (req) => checkpointsService.api.restoreFile(req),
      readObject: (hash) => objects.get(hash),
      fileOps: (workspaceId) => filesService.fileOpsFor(workspaceId),
      createCheckpoint: (input) => checkpointsService.store.create(input),
    }),
    diffFs: {
      readObject: (hash) => objects.get(hash),
      readCurrent: async (workspaceId, path, maxBytes) => readBytesOrNull(await workspaceService.rootOf(workspaceId), path, maxBytes),
    },
    isolationLevel: () => permissions.isolationLevel,
    audit: (entry) => audit.recordToolExecution(entry),
    auditDecision: (request, decision, toolCallId) => audit.recordDecision(request, decision, toolCallId),
    openRuntimePort: () => openAgentRuntimePort(workers),
    logger,
  });
  const missionsApi = missions.api;

  // J2-B L5: bounded sub-missions; a writing child works in a git worktree under <dataDir>.
  submissions = createSubmissionsService({
    store,
    missions: missions.controller,
    worktrees: createWorktreeManager({ dataDir }),
    rootOf: (workspaceId) => workspaceService.rootOf(workspaceId),
    facts: (workspaceId) => workspaceService.api.facts({ workspaceId, refresh: false }).catch(() => null),
    // The integration writes into the PROJECT: its paths are checked there, not in the worktree.
    permissions: { evaluate: (request) => permissions.evaluateInProject(request) },
    checkpoints: { create: (input) => checkpointsService.store.create(input) },
    projectFiles: (workspaceId) => filesService.fileOpsFor(workspaceId),
    worktreeFiles: (workspaceId, root) =>
      createWorkspaceFileOps({
        workspaceId,
        root,
        matcher: createIgnoreMatcher(root),
        checkpoints: checkpointsService.store,
        rgPath,
        trash: (path) => shell.trashItem(path),
      }),
    commandRunner: (root) =>
      createProcessCommandRunner({
        resolveCwd: async (_workspaceId, cwd) => {
          try {
            return await resolveExisting(root, cwd);
          } catch {
            return null;
          }
        },
      }),
    dailyLimitUsd: () => DEFAULT_DAILY_BUDGET_USD,
  });

  // J2-B L6: scheduled missions (run only while NOVA is open; missed runs follow their policy).
  const missionRepo = createMissionRepo(store.db);
  schedules = createSchedulesService({
    repo: createScheduleRepo(store.db),
    missions: missionsApi,
    missionState: (missionId) => missionRepo.get(missionId)?.state ?? null,
    workspaceExists: (workspaceId) => workspaceRepo.get(workspaceId) !== null,
    supportsTools: (modelId) => store.loadCatalog("openrouter")?.models.find((model) => model.id === modelId)?.supportsTools ?? null,
    // Same cap the mission controller enforces (DEFAULT_DAILY_BUDGET_USD), same day start.
    dailyRemainingUsd: () => DEFAULT_DAILY_BUDGET_USD - missionRepo.cost.summary("", new Date().setHours(0, 0, 0, 0)).dailySpentUsd,
    logger,
  });
  const scheduleService = schedules;
  scheduleService.onEvent((event) => {
    push(IPC_CHANNELS.schedulesEvent, event);
    desktop?.notify();
  });
  companion = createCompanionService({
    signals: createSignalRepo(store.db),
    suggestions: createSuggestionRepo(store.db),
    missions: missionsApi,
    broadcast: (event) => push(IPC_CHANNELS.companionEvent, event),
    notify: createNotifier(),
    isFocused: () => mainWindow?.isFocused() ?? false,
    conversationTitle: (conversationId) => store.getConversation(conversationId)?.title ?? null,
    runningSession: async (sessionId) => {
      const found = (await terminal.list({ workspaceId: null })).find((item) => item.id === sessionId);
      return found?.state === "running" ? { workspaceId: found.workspaceId, command: null } : null;
    },
  });

  // Startup maintenance: nothing of a previous run is replayed (approvals expire, missions fail once).
  audit.purgeExpired();
  approvals.expireOrphans();
  missions.controller.recoverInterrupted();
  // After recoverInterrupted: children left open are settled, then missed schedules are applied.
  void submissions.controller.recover().catch((error: unknown) => logger.warn("sub-missions recovery failed", { error: describeError(error) }));
  scheduleService.start();
  void checkpointsService.purge().catch((error: unknown) => logger.warn("checkpoint purge failed", { error: describeError(error) }));

  const chatEvents = new ChatEventHub((event) => {
    push(IPC_CHANNELS.chatEvent, event);
    companion?.onChatEvent(event);
    // J2-B L2: the conversation's context usage after each answer (gauge, « Résumer maintenant »).
    if (event.type === "completed") contextService.observeConversation(event.conversationId);
  });
  const runner = new ChatRunner({
    store,
    provider,
    resolveApiKey,
    getSettings: () => store.getSettings(),
    emit: chatEvents.emit,
    logger,
    // A key refused mid-chat becomes the connection's recorded state (Nomi, composer, Home read it).
    onProviderError: (error, apiKey) => connections.recordChatFailure(apiKey, error),
    prepareTurn: createChatContext({ fileOps: (workspaceId) => filesService.fileOpsFor(workspaceId), web }),
    // J2-B L2: an applied summary replaces the messages it covers in what the model receives.
    historyForModel: (conversationId, history) => contextService.historyForModel(conversationId, history),
    // J2-B L7: pasted images need a model whose catalog entry accepts "image"; effort needs reasoning.
    modelInfo: async (modelId) => (await catalog.catalog({ refresh: false })).models.find((model) => model.id === modelId) ?? null,
  });

  // J2-B L7 desktop presence -------------------------------------------------
  desktop = createDesktopService({
    sources: {
      missions: async () => (await missionsApi.list({ workspaceId: null, limit: 200 })).items,
      pendingApprovals: async () => (await approvals.list({ workspaceId: null, missionId: null, status: "pending" })).length,
      terminals: () => terminal.list({ workspaceId: null }),
      runningProcesses: async () => (await processes.api.list({ workspaceId: null, missionId: null })).filter((item) => item.state === "running").length,
      schedules: () => ({ activeCount: scheduleService.activeCount(), nextDueAt: scheduleService.nextDueAt() }),
    },
    keepRunningOnClose: () => store.getSettings().desktop.keepRunningOnClose,
    trayAvailable: () => presence?.trayAvailable() ?? false,
    push: (event) => push(IPC_CHANNELS.desktopEvent, event),
    logger,
  });
  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow(context);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  presence = createDesktopPresence({
    desktop,
    createTray: () => new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL).resize({ width: trayIconSize(process.platform) })),
    buildMenu: (template) => Menu.buildFromTemplate(template),
    keepRunningOnClose: () => store.getSettings().desktop.keepRunningOnClose,
    showWindow: showMainWindow,
    quit: () => app.quit(),
    askQuit: async (warning) => {
      const options = {
        type: "warning" as const,
        title: warning.title,
        message: warning.message,
        detail: warning.detail,
        buttons: [...warning.buttons],
        defaultId: QUIT_CANCEL,
        cancelId: QUIT_CANCEL,
        noLink: true,
      };
      const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      return answer.response === QUIT_CONFIRM;
    },
    notify: (body) => {
      if (Notification.isSupported()) new Notification({ title: APP_NAME, body, silent: true }).show();
    },
    platform: process.platform,
    logger,
  });
  const autopilot = createAutopilotService({
    provider,
    resolveApiKey,
    models: async () => (await catalog.catalog({ refresh: false })).models,
    dataCollection: () => store.getSettings().privacy.providerDataCollection,
    enabled: () => store.getSettings().chat.autopilot,
    logger,
  });
  const api = createMainApi({
    store,
    runner,
    connections,
    catalog,
    chatEvents,
    app: createAppService({
      info: {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        electronVersion: process.versions.electron,
        dataDir,
        logDir,
      },
      vault,
      openExternal: (url) => shell.openExternal(url),
    }),
    atelier: {
      workspace: workspaceService.api,
      files: filesService.api,
      search: searchService.api,
      terminal,
      missions: missionsApi,
      approvals: { list: (req) => approvals.list(req), decide: (req) => approvals.decide(req) },
      permissions: {
        getProfile: (req) => permissions.getProfile(req),
        setProfile: (req) => permissions.setProfile(req),
        listRules: (req) => permissions.listRules(req),
        revokeRules: (req) => permissions.revokeRules(req),
      },
      audit: { list: async (req) => audit.entries(req) },
      git: gitService.api,
      mcp: mcp.api(),
      web: web.ipc(),
      companion: companion.api,
      checkpoints: checkpointsService.api,
    },
    // J2-B: each lane's service replaces its group here (J2-B lane map).
    harness: {
      ...unavailableHarnessApi(),
      processes: processes.api,
      context: contextService.api,
      skills: skills.api,
      submissions: submissions.api,
      schedules: scheduleService.api,
      desktop: desktop.api,
      autopilot: autopilot.api,
      timeline: timeline.api,
    },
  });
  // The desktop state carries `keepRunningOnClose`: republish it when settings change.
  const updateSettings = api.settings.update;
  api.settings.update = async (patch) => {
    const next = await updateSettings(patch);
    desktop?.notify();
    return next;
  };
  registerIpcRoutes(buildIpcRoutes(api, logger), (frame) => isTrustedSender(frame, devOrigin), logger);

  let closed = false;
  let shutdown: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    // J2-B L7: something runs → ask first (native dialog listing it); nothing runs → no question.
    if (!quitConfirmed) {
      void presence?.confirmQuit().then((confirmed) => {
        if (!confirmed) return;
        quitConfirmed = true;
        presence?.setQuitting(true);
        app.quit();
      });
      return;
    }
    // The window closes first: its unsaved-edits question may cancel the quit, so nothing is shut
    // down before the answer. Its `closed` handler quits again, then without a window.
    const window = mainWindow;
    if (!shutdown && window && !window.isDestroyed()) {
      quitAfterClose = true;
      window.close();
      return;
    }
    shutdown ??= (async () => {
      presence?.dispose();
      desktop?.dispose();
      // No scheduled run starts during the quit.
      scheduleService.stop();
      runner.stopAll();
      companion?.dispose();
      contextService.dispose();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_IDLE_TIMEOUT_MS));
      // Agent processes run in detached groups: nothing else kills them once NOVA exits.
      const commandsStopped = Promise.all([processes.stopEverything(), submissions?.stopEverything(), chain.stopAll()]).catch(
        (error: unknown) => logger.warn("agent processes stop failed", { error: describeError(error) }),
      );
      await mcp.shutdown().catch((error: unknown) => logger.warn("mcp shutdown failed", { error: describeError(error) }));
      // Workers exit after their own cleanup (the pty-host kills its terminals' trees): wait for it.
      const workersStopped = workers.stopAll();
      await Promise.race([Promise.all([commandsStopped, workersStopped, runner.idle()]), timeout]);
      store.close();
      logger.info("stopped");
    })()
      .catch((error: unknown) => logger.error("shutdown failed", { error: describeError(error) }))
      .finally(() => {
        closed = true;
        app.quit();
      });
  });

  mainWindow = createWindow(context);
  app.on("activate", showMainWindow);
  logger.info("window created", { renderer: overrides.rendererDevUrl ? "dev-server" : "nova-protocol" });
  void vault.status().then((status) => logger.info("vault detected", { ...status }));
}

if (process.argv.includes(SELFTEST_FLAG)) {
  // Diagnostics mode (see selftest.ts): no window, no store, no single-instance lock.
  const logger = createFileLogger({ dir: join(app.getPath("userData"), "logs"), fileName: "selftest.log" });
  void app
    .whenReady()
    .then(async () => {
      const pool = await createWorkerPool(logger);
      const chain = createChainService({ entry: join(import.meta.dirname, "workers", "chain-host.js"), logger });
      const report = await runWorkerSelfTest(pool, { chain: () => chain.selfTest() });
      await pool.stopAll();
      process.stdout.write(`${JSON.stringify({ novaSelfTest: report })}\n`);
      app.exit(report.ok ? 0 : 1);
    })
    .catch((error: unknown) => {
      process.stdout.write(`${JSON.stringify({ novaSelfTest: { ok: false, error: describeError(error) } })}\n`);
      app.exit(1);
    });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const dataDir = app.getPath("userData");
  const logDir = join(dataDir, "logs");
  const logger = createFileLogger({ dir: logDir, mirrorToConsole: !app.isPackaged });
  logger.info("starting", {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });
  if (overrides.userDataDir) logger.warn("override active: NOVA_USER_DATA_DIR");
  if (overrides.openRouterBaseUrl) {
    logger.warn("override active: NOVA_OPENROUTER_BASE_URL", { target: overrides.openRouterBaseUrl });
  }
  if (overrides.rendererDevUrl) logger.info("renderer from dev server", { origin: devOrigin });
  for (const name of overrides.ignored) logger.warn("override ignored", { name });

  process.on("uncaughtException", (error) => logger.error("uncaught exception", { error: describeError(error) }));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", { error: describeError(reason) }));
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents, { devOrigin, logger }));
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  start(logger, dataDir, logDir).catch((error: unknown) => {
    logger.error("startup failed", { error: describeError(error) });
    dialog.showErrorBox("NOVA ne peut pas démarrer", `Erreur au démarrage. Détails dans le journal : ${logger.file}`);
    app.exit(1);
  });
}
