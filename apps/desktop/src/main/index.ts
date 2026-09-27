// NOVA main process: data directory, store, vault, provider, runtime, IPC, window.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, MessageChannelMain, Notification, app, dialog, net, safeStorage, session, shell } from "electron";
import { ChatRunner } from "@nova/agent-runtime";
import type { SystemNotification } from "@nova/companion";
import { detectIsolation } from "@nova/permissions";
import { OpenRouterProvider } from "@nova/providers";
import { IPC_CHANNELS, type IpcChannel } from "@nova/shared";
import {
  createApprovalRepo,
  createAuditRepo,
  createCheckpointRepo,
  createEditorStateRepo,
  createMcpRepo,
  createPolicyRepo,
  createSignalRepo,
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
import { createGitClient, createObjectStore, readBytesOrNull, resolveExisting } from "@nova/workspace";
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
import { createAppService } from "./services/app-service";
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
import { McpService } from "./services/mcp-service";
import { createMissionsService, createReviewFsGate, type MissionsService } from "./services/missions-service";
import { PermissionsService } from "./services/permissions-service";
import { createSearchService } from "./services/search-service";
import { createTerminalService } from "./services/terminal-service";
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
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
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
    },
  });

  const web = new WebService({
    policies: createWebPolicyRepo(store.db),
    cache: createWebCacheRepo(store.db),
    usage: createWebSearchUsageRepo(store.db),
    providerId: provider.id,
    knownSecrets: () => (knownKey ? [knownKey] : []),
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
    secrets: store,
    vault,
    host: workers.instance("mcp-host"),
    workspaceRoot: (workspaceId) => workspaceRepo.get(workspaceId)?.rootPath ?? null,
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
  terminal.onEvent((event) => push(IPC_CHANNELS.terminalEvent, event));
  terminal.onExit((ended, outputTail) =>
    companion?.onProcessExit({ sessionId: ended.id, exitCode: ended.exitCode, signal: null, outputTail }),
  );

  // Agent tools run in main under the permission engine (L0: no shell, confined cwd, scrubbed env).
  const commandRunner = createProcessCommandRunner({
    resolveCwd: async (workspaceId, cwd) => {
      try {
        return await resolveExisting(await workspaceService.rootOf(workspaceId), cwd);
      } catch {
        return null;
      }
    },
  });
  const objects = createObjectStore(checkpointObjectsDir(dataDir));
  const toolDeps = async (workspaceId: string): Promise<ToolDeps> => ({
    files: await filesService.fileOpsFor(workspaceId),
    facts: () => workspaceService.api.facts({ workspaceId, refresh: false }).catch(() => null),
    commands: commandRunner,
    git: { status: gitService.api.status, diff: gitService.api.diff, commit: gitService.commit },
    web,
    mcp,
  });
  missions = createMissionsService({
    store,
    provider,
    resolveApiKey,
    push: (event) => {
      push(IPC_CHANNELS.missionsEvent, event);
      companion?.onMissionEvent(event);
    },
    toolDeps,
    mcpTools: (workspaceId) => mcp.listToolsForModel(workspaceId),
    permissions,
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
      readCurrent: async (workspaceId, path) => readBytesOrNull(await workspaceService.rootOf(workspaceId), path),
    },
    isolationLevel: () => permissions.isolationLevel,
    audit: (entry) => audit.recordToolExecution(entry),
    openRuntimePort: () => openAgentRuntimePort(workers),
    logger,
  });
  const missionsApi = missions.api;
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
  void checkpointsService.purge().catch((error: unknown) => logger.warn("checkpoint purge failed", { error: describeError(error) }));

  const chatEvents = new ChatEventHub((event) => {
    push(IPC_CHANNELS.chatEvent, event);
    companion?.onChatEvent(event);
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
  });
  registerIpcRoutes(buildIpcRoutes(api, logger), (frame) => isTrustedSender(frame, devOrigin), logger);

  let closed = false;
  let shutdown: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    shutdown ??= (async () => {
      runner.stopAll();
      companion?.dispose();
      await mcp.shutdown().catch((error: unknown) => logger.warn("mcp shutdown failed", { error: describeError(error) }));
      workers.stopAll();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_IDLE_TIMEOUT_MS));
      await Promise.race([runner.idle(), timeout]);
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(context);
  });
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
      const report = await runWorkerSelfTest(pool);
      pool.stopAll();
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
