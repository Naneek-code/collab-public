import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";

const WIN_W = 440;
const MARGIN = 16;

let overlayWin: BrowserWindow | null = null;
let mainWin: BrowserWindow | null = null;
let focusedTileId: string | null = null;
let focusedTileCwd: string | null = null;
let notifCounter = 0;
let overlayReady = false;
let lastHeight = 120;

interface PendingNotification {
  id: string;
  title: string;
  body: string;
  tileId: string | null;
  cwd: string | null;
  sound?: string;
}

const pendingQueue: PendingNotification[] = [];
const recentNotifs = new Map<string, number>();

function getPreloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`);
}

function getRendererURL(name: string): string {
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    return `${process.env["ELECTRON_RENDERER_URL"]}/${name}/index.html`;
  }
  return pathToFileURL(
    join(__dirname, `../renderer/${name}/index.html`),
  ).href;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").toLowerCase();
}

function applyBounds(height: number): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const h = Math.min(Math.max(height, 1), wa.height - MARGIN * 2);
  lastHeight = h;
  overlayWin.setBounds({
    x: wa.x + wa.width - WIN_W - MARGIN,
    y: wa.y + wa.height - h - MARGIN,
    width: WIN_W,
    height: h,
  });
}

function reassertTopmost(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  if (overlayWin.isVisible()) overlayWin.moveTop();
}

function createOverlayWindow(): BrowserWindow {
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: wa.x + wa.width - WIN_W - MARGIN,
    y: wa.y + wa.height - lastHeight - MARGIN,
    width: WIN_W,
    height: lastHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: getPreloadPath("notification-overlay"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setContentProtection(true);
  win.setAlwaysOnTop(true, "screen-saver");

  win.loadURL(getRendererURL("notification-overlay"));

  win.webContents.on("did-finish-load", () => {
    overlayReady = true;
    win.webContents.send("notif:theme", nativeTheme.shouldUseDarkColors);
    flushPendingQueue();
  });

  win.webContents.on("did-fail-load", (_event, code, desc) => {
    console.error("[notification-overlay] load failed:", code, desc);
  });

  return win;
}

function flushPendingQueue(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayReady) return;
  while (pendingQueue.length > 0) {
    overlayWin.webContents.send("notif:show", pendingQueue.shift()!);
  }
  if (overlayWin && !overlayWin.isVisible()) overlayWin.showInactive();
  reassertTopmost();
}

function ensureOverlay(): BrowserWindow | null {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  if (!mainWin || mainWin.isDestroyed()) return null;
  overlayReady = false;
  overlayWin = createOverlayWindow();

  overlayWin.on("closed", () => {
    overlayWin = null;
    overlayReady = false;
  });

  return overlayWin;
}

export function initNotificationOverlay(main: BrowserWindow): void {
  mainWin = main;

  ipcMain.on(
    "notif:clicked",
    (_event, data: { tileId: string | null; cwd: string | null }) => {
      if (mainWin && !mainWin.isDestroyed()) {
        if (mainWin.isMinimized()) mainWin.restore();
        mainWin.show();
        mainWin.focus();
        if (data?.tileId || data?.cwd) {
          mainWin.webContents.send("shell:notification-navigate", data);
        }
      }
    },
  );

  ipcMain.on(
    "notif:resize",
    (_event, data: { height: number; empty: boolean }) => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      if (data.empty || !data.height) {
        if (overlayWin.isVisible()) overlayWin.hide();
        return;
      }
      applyBounds(data.height);
      if (!overlayWin.isVisible()) overlayWin.showInactive();
      reassertTopmost();
    },
  );

  ipcMain.on(
    "shell:tile-focused",
    (
      _event,
      data: string | { tileId: string | null; cwd: string | null } | null,
    ) => {
      if (typeof data === "string" || data == null) {
        focusedTileId = data ?? null;
        focusedTileCwd = null;
      } else {
        focusedTileId = data.tileId;
        focusedTileCwd = data.cwd;
      }
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send("notif:dismiss", {
          tileId: focusedTileId,
          cwd: focusedTileCwd,
        });
      }
    },
  );

  nativeTheme.on("updated", () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send(
        "notif:theme",
        nativeTheme.shouldUseDarkColors,
      );
    }
  });

  screen.on("display-metrics-changed", () => {
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
      applyBounds(lastHeight);
    }
  });

  main.on("focus", reassertTopmost);
  main.on("blur", reassertTopmost);

  main.on("closed", () => {
    mainWin = null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  });
}

export function showOverlayNotification(opts: {
  title: string;
  body: string;
  tileId?: string | null;
  cwd?: string | null;
  sound?: "finished" | "attention";
}): void {
  const tileId = opts.tileId ?? null;
  const cwd = opts.cwd ?? null;

  const appVisible = mainWin && !mainWin.isDestroyed()
    && !mainWin.isMinimized();

  if (appVisible) {
    if (tileId) {
      if (tileId === focusedTileId) return;
    } else if (
      cwd && focusedTileCwd &&
      normalizeCwd(cwd) === normalizeCwd(focusedTileCwd)
    ) {
      return;
    }
  }

  const now = Date.now();
  const dedupeKey = `${cwd ? normalizeCwd(cwd) : tileId ?? ""}|${opts.body}`;
  for (const [k, t] of recentNotifs) {
    if (now - t > 10000) recentNotifs.delete(k);
  }
  const last = recentNotifs.get(dedupeKey);
  if (last && now - last < 4000) return;
  recentNotifs.set(dedupeKey, now);

  const win = ensureOverlay();
  if (!win) return;

  const notif: PendingNotification = {
    id: `notif-${++notifCounter}`,
    title: opts.title,
    body: opts.body,
    tileId,
    cwd,
    ...(opts.sound ? { sound: opts.sound } : {}),
  };

  if (overlayReady) {
    win.webContents.send("notif:show", notif);
    if (!win.isVisible()) win.showInactive();
    reassertTopmost();
  } else {
    pendingQueue.push(notif);
  }

  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("shell:notification-badge", { tileId, cwd });
  }
}

export function setFocusedTileId(id: string | null): void {
  focusedTileId = id;
}

export function dismissOverlayByTileId(tileId: string): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send("notif:dismiss", { tileId });
  }
}
