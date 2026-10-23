/**
 * Electron main process.
 *
 * Reads go through the same `@munin/application` service the CLI uses; the main
 * process never rescans on navigation and never parses CLI text. The window is
 * a compact, dark, single-window shell with a tray; background work never shows
 * or focuses it.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, Tray } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMuninService,
  toServiceError,
  type ActivityDTO,
  type ExplicitScanOptions,
  type FindingDetailDTO,
  type FindingListDTO,
  type HealthDTO,
  type OverviewDTO,
  type PrivacyDTO,
  type ReadOptions,
  type ScanDTO,
  type SessionDetailDTO,
  type SourceStatusDTO,
  type UsageOverviewDTO,
} from "@munin/application";
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type AppInfoDTO,
  type IpcResult,
  type ScanRequest,
} from "../shared/ipc.js";
import {
  sanitizeFindingRequest,
  sanitizeReadRequest,
  sanitizeScanRequest,
  sanitizeSessionRequest,
} from "./requests.js";
import { isTrustedRendererUrl, type TrustOptions } from "./security.js";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // dist/main/
const APP_ROOT = join(HERE, "../.."); // apps/desktop
const RENDERER_DIR = join(APP_ROOT, "dist/renderer");
const RENDERER_ENTRY = join(RENDERER_DIR, "index.html");
const PRELOAD = join(HERE, "../preload/index.cjs");
const TRAY_ICON = join(APP_ROOT, "assets/tray.png");
const DEV_URL = process.env.MUNIN_DESKTOP_DEV_URL;

const service = createMuninService();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function trustOptions(): TrustOptions {
  return {
    rendererDir: RENDERER_DIR,
    ...(DEV_URL === undefined ? {} : { devUrl: DEV_URL }),
  };
}

function trustedFrame(url: string | null | undefined): boolean {
  return typeof url === "string" && isTrustedRendererUrl(url, trustOptions());
}

function reject(): IpcResult<never> {
  return {
    ok: false,
    error: { code: "request.invalid", kind: "usage", message: "Request rejected." },
  };
}

/**
 * Register one allowlisted channel. The handler receives the raw payload; it
 * must validate it with a sanitizer before touching the service.
 */
function guarded<T>(channel: string, handler: (raw: unknown, senderUrl: string) => Promise<T>) {
  ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcResult<T>> => {
    const senderUrl = event.senderFrame?.url ?? "";
    if (!trustedFrame(senderUrl)) return reject();
    try {
      return { ok: true, data: await handler(raw, senderUrl) };
    } catch (error) {
      const safe = toServiceError(error);
      if (safe.code === "internal") console.error("[munin] desktop request failed:", error);
      return { ok: false, error: safe };
    }
  });
}

function readHandler<T>(channel: string, run: (request: ReadOptions) => Promise<T>): void {
  guarded<T>(channel, (raw) => run(sanitizeReadRequest(raw)));
}

function scanOptionsOf(request: ScanRequest): ExplicitScanOptions {
  return {
    ...(request.days === undefined ? {} : { sinceDays: request.days }),
    ...(request.tz === undefined ? {} : { zone: request.tz }),
    ...(request.full === true ? { full: true } : {}),
  };
}

function broadcastScan(scan: ScanDTO): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_EVENTS.scan, scan);
}

function registerIpc(): void {
  readHandler<OverviewDTO>(IPC_CHANNELS.overview, (request) => service.getOverview(request));
  readHandler<SourceStatusDTO>(IPC_CHANNELS.sourceStatus, (request) =>
    service.getSourceStatus(request),
  );
  readHandler<FindingListDTO>(IPC_CHANNELS.findings, (request) => service.getFindings(request));
  readHandler<UsageOverviewDTO>(IPC_CHANNELS.usage, (request) => service.getUsage(request));
  readHandler<ActivityDTO>(IPC_CHANNELS.activity, (request) => service.getActivity(request));
  readHandler<HealthDTO>(IPC_CHANNELS.health, (request) => service.getHealth(request));
  readHandler<PrivacyDTO>(IPC_CHANNELS.privacy, (request) =>
    service.getPrivacyStatus(request),
  );

  guarded<FindingDetailDTO | null>(IPC_CHANNELS.finding, (raw) => {
    const { rule, ...read } = sanitizeFindingRequest(raw);
    return service.getFinding(rule, read);
  });
  guarded<SessionDetailDTO | null>(IPC_CHANNELS.session, (raw) => {
    const { sessionId, ...read } = sanitizeSessionRequest(raw);
    return service.getSessionDetail(sessionId, read);
  });

  guarded<ScanDTO>(IPC_CHANNELS.scan, async (raw) => {
    const request = sanitizeScanRequest(raw);
    const scan = await service.runScan(scanOptionsOf(request));
    broadcastScan(scan);
    return scan;
  });

  guarded<AppInfoDTO>(IPC_CHANNELS.appInfo, async () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    node: process.versions.node,
    chrome: process.versions.chrome ?? "unknown",
    platform: `${process.platform} ${process.arch}`,
    packaged: app.isPackaged,
  }));

  guarded<null>(IPC_CHANNELS.minimize, async (_raw, senderUrl) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL() === senderUrl) window.minimize();
    }
    return null;
  });
}

function showWindow(): void {
  if (mainWindow === null) {
    void createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(showOnReady = true): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 410,
    height: 624,
    useContentSize: true,
    minWidth: 360,
    minHeight: 480,
    show: false,
    backgroundColor: "#111416",
    title: "Munin",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = window;

  window.once("ready-to-show", () => {
    if (showOnReady) window.show();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[munin] renderer failed to load (${code}): ${description}`);
    window.show();
  });

  if (DEV_URL !== undefined) await window.loadURL(DEV_URL);
  else await window.loadFile(RENDERER_ENTRY);
  return window;
}

async function scanFromTray(): Promise<void> {
  try {
    const scan = await service.runScan();
    broadcastScan(scan);
    tray?.setToolTip(`Munin — last scan ${scan.at}`);
  } catch (error) {
    // A click must not open a dialog over the user's work. The failure is
    // visible the next time they open Munin.
    console.error("[munin] tray scan failed:", toServiceError(error).message);
  }
}

function createTray(): void {
  if (!existsSync(TRAY_ICON)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip("Munin");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show Munin", click: () => showWindow() },
        { label: "Scan now", click: () => void scanFromTray() },
        { label: "Hide Munin", click: () => mainWindow?.hide() },
        { type: "separator" },
        {
          label: "Quit Munin",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("click", () => {
      if (mainWindow !== null && mainWindow.isVisible()) mainWindow.hide();
      else showWindow();
    });
  } catch (error) {
    // A missing status-notifier host must not stop the app; the window still
    // works and a second launch restores it.
    console.error("[munin] tray unavailable:", error);
    tray = null;
  }
}

function harden(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isTrustedRendererUrl(url, trustOptions())) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
}

const SMOKE_TAB_READY: Record<string, RegExp> = {
  overview: /spend|no usage in this window/i,
  optimize: /findings|no findings/i,
  usage: /by model/i,
  health: /health/i,
};

async function waitForBodyText(
  window: BrowserWindow,
  ready: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = String(await window.webContents.executeJavaScript("document.body.innerText"));
    if (ready.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return text;
}

/**
 * Smoke path for CI-less verification: read real data through the same service
 * the UI uses, optionally click a tab, print JSON lines and exit. Never creates
 * a tray.
 */
async function runSmoke(): Promise<void> {
  const request: ReadOptions = {
    ...(process.env.MUNIN_DESKTOP_SMOKE_DB === undefined
      ? {}
      : { db: process.env.MUNIN_DESKTOP_SMOKE_DB }),
    ...(process.env.MUNIN_DESKTOP_SMOKE_STATE === undefined
      ? {}
      : { stateDir: process.env.MUNIN_DESKTOP_SMOKE_STATE }),
  };
  try {
    const overview = await service.getOverview(request);
    const activity = await service.getActivity(request);
    const health = await service.getHealth(request);
    const findings = await service.getFindings(request);
    console.log(
      `SMOKE_RESULT ${JSON.stringify({
        ok: true,
        electron: process.versions.electron,
        node: process.versions.node,
        sourceStatus: overview.source.status,
        sourceSchema: overview.health.schema,
        calls: overview.totals.calls,
        sessions: overview.totals.sessions,
        headlineUsd: overview.totals.headlineUsd,
        findings: findings.findings.length,
        healthHasData: health.data !== null,
        activityStatus: activity.status,
        snapshots: activity.snapshots.length,
      })}`,
    );
  } catch (error) {
    const safe = toServiceError(error);
    console.log(
      `SMOKE_RESULT ${JSON.stringify({
        ok: false,
        code: safe.code,
        message: safe.message,
        electron: process.versions.electron,
        node: process.versions.node,
      })}`,
    );
  }

  if (process.env.MUNIN_DESKTOP_SMOKE_UI === "1") {
    try {
      registerIpc();
      const window = await createWindow(false);
      const tab = process.env.MUNIN_DESKTOP_SMOKE_TAB ?? "overview";
      const ready = SMOKE_TAB_READY[tab] ?? SMOKE_TAB_READY.overview ?? /./;
      if (tab !== "overview") {
        await window.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('[data-tab="${tab}"]'); if (el) el.click(); return Boolean(el); })()`,
        );
      }
      const text = await waitForBodyText(window, ready);
      const ok = ready.test(text);
      const screenshotPath = process.env.MUNIN_DESKTOP_SMOKE_SCREENSHOT;
      if (screenshotPath !== undefined) {
        const image = await window.webContents.capturePage();
        writeFileSync(screenshotPath, image.toPNG());
      }
      console.log(`SMOKE_UI ${JSON.stringify({ ok, tab, text: text.slice(0, 600) })}`);
    } catch (error) {
      console.log(
        `SMOKE_UI ${JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        })}`,
      );
    }
  }
  app.exit(0);
}

async function start(): Promise<void> {
  harden();
  if (process.env.MUNIN_DESKTOP_SMOKE === "1") {
    await runSmoke();
    return;
  }
  Menu.setApplicationMenu(null);
  registerIpc();
  await createWindow();
  createTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("activate", () => showWindow());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error("[munin] failed to start:", error);
      app.exit(1);
    });
}
