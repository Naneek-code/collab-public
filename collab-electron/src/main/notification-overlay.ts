import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";
import { app } from "electron";

function dbg(msg: string): void {
  try {
    appendFileSync(
      join(app.getPath("temp"), "collab-notif-debug.log"),
      `${new Date().toISOString()} ${msg}\n`,
    );
  } catch {}
}

let overlayWin: BrowserWindow | null = null;
let mainWin: BrowserWindow | null = null;
let focusedTileId: string | null = null;
let focusedTileCwd: string | null = null;
let notifCounter = 0;
let overlayReady = false;

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

function createOverlayWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.workArea;
  const winW = 420;
  const winH = 520;
  const margin = 16;

  const win = new BrowserWindow({
    width: winW,
    height: winH,
    x: x + width - winW - margin,
    y: y + height - winH - margin,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
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

  const url = getRendererURL("notification-overlay");
  win.loadURL(url);

  win.webContents.on("did-finish-load", () => {
    overlayReady = true;
    win.webContents.send("notif:theme", nativeTheme.shouldUseDarkColors);
    flushPendingQueue();
  });

  win.webContents.on(
    "did-fail-load",
    (_event, code, desc) => {
      console.error(
        "[notification-overlay] load failed:", code, desc,
      );
    },
  );

  return win;
}

function flushPendingQueue(): void {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayReady) return;
  while (pendingQueue.length > 0) {
    const notif = pendingQueue.shift()!;
    overlayWin.webContents.send("notif:show", notif);
  }
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
    (
      _event,
      data: { tileId: string | null; cwd: string | null },
    ) => {
      dbg(`clicked ${JSON.stringify(data)}`);
      if (mainWin && !mainWin.isDestroyed()) {
        if (mainWin.isMinimized()) mainWin.restore();
        mainWin.show();
        mainWin.focus();
        if (data?.tileId || data?.cwd) {
          mainWin.webContents.send(
            "shell:notification-navigate",
            data,
          );
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
      const wa = screen.getPrimaryDisplay().workArea;
      const winW = 420;
      const margin = 16;
      const winH = Math.min(data.height, wa.height - margin * 2);
      overlayWin.setBounds({
        x: wa.x + wa.width - winW - margin,
        y: wa.y + wa.height - winH - margin,
        width: winW,
        height: winH,
      });
      if (!overlayWin.isVisible()) overlayWin.showInactive();
      // Transparent windows on Windows can lose their mouse-input region
      // after a resize; re-assert it so toasts stay clickable.
      overlayWin.setIgnoreMouseEvents(false);
      dbg(
        `resize h=${winH} visible=${overlayWin.isVisible()}`
        + ` bounds=${JSON.stringify(overlayWin.getBounds())}`,
      );
    },
  );

  ipcMain.on(
    "shell:tile-focused",
    (
      _event,
      data: string | { tileId: string | null; cwd: string | null },
    ) => {
      if (typeof data === "string" || data == null) {
        focusedTileId = data as string | null;
        focusedTileCwd = null;
      } else {
        focusedTileId = data.tileId;
        focusedTileCwd = data.cwd;
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

  main.on("closed", () => {
    mainWin = null;
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.close();
    }
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
      cwd.replace(/\\/g, "/").toLowerCase() ===
      focusedTileCwd.replace(/\\/g, "/").toLowerCase()
    ) {
      return;
    }
  }

  const now = Date.now();
  const dedupeKey = `${tileId ?? cwd ?? ""}|${opts.body}`;
  for (const [k, t] of recentNotifs) {
    if (now - t > 10000) recentNotifs.delete(k);
  }
  const last = recentNotifs.get(dedupeKey);
  if (last && now - last < 2500) return;
  recentNotifs.set(dedupeKey, now);

  const win = ensureOverlay();
  if (!win) return;

  const notif: PendingNotification = {
    id: `notif-${++notifCounter}`,
    title: opts.title,
    body: opts.body,
    tileId,
    cwd,
    sound: opts.sound,
  };

  dbg(`show ${notif.id} tile=${tileId} cwd=${cwd} body="${opts.body}"`);
  if (overlayReady) {
    win.webContents.send("notif:show", notif);
  } else {
    pendingQueue.push(notif);
  }

  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(
      "shell:notification-badge",
      { tileId, cwd },
    );
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
