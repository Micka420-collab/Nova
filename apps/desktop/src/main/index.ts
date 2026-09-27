// NOVA main process: data directory, store, vault, provider, runtime, IPC, window.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, dialog, net, safeStorage, session, shell } from "electron";
import { ChatRunner } from "@nova/agent-runtime";
import { OpenRouterProvider } from "@nova/providers";
import { IPC_CHANNELS, type ChatStreamEvent } from "@nova/shared";
import { openNovaStore, type NovaStore } from "@nova/storage";
import { createMainApi } from "./api";
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
import { CatalogService } from "./services/catalog-service";
import { ChatEventHub } from "./services/chat-events";
import { ConnectionService } from "./services/connection-service";
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

function forwardChatEvent(event: ChatStreamEvent): void {
  const window = mainWindow;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.chatEvent, event);
  }
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
  const resolveApiKey = (): Promise<string | null> => connections.resolveApiKey();
  const chatEvents = new ChatEventHub(forwardChatEvent);
  const runner = new ChatRunner({
    store,
    provider,
    resolveApiKey,
    getSettings: () => store.getSettings(),
    emit: chatEvents.emit,
    logger,
    // A key refused mid-chat becomes the connection's recorded state (Nomi, composer, Home read it).
    onProviderError: (error, apiKey) => connections.recordChatFailure(apiKey, error),
  });
  const api = createMainApi({
    store,
    runner,
    connections,
    catalog: new CatalogService({ store, provider, resolveApiKey, logger }),
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
  });
  registerIpcRoutes(buildIpcRoutes(api, logger), (frame) => isTrustedSender(frame, devOrigin), logger);

  let closed = false;
  let shutdown: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    shutdown ??= (async () => {
      runner.stopAll();
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

if (!app.requestSingleInstanceLock()) {
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
