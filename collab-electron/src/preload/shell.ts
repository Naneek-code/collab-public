import { contextBridge, ipcRenderer, webUtils } from "electron";

interface ViewConfig {
  src: string;
  preload: string;
}

interface AllViewConfigs {
  nav: ViewConfig;
  viewer: ViewConfig;
  terminal: ViewConfig;
  terminalTile: ViewConfig;
  graphTile: ViewConfig;
  dockerTile: ViewConfig;
  codeEditorTile: ViewConfig;
  settings: ViewConfig;
  tileList: ViewConfig;
  agentChat: ViewConfig;
}

const ALLOWED_PANELS = new Set([
  "nav", "viewer", "terminal", "terminalTile",
  "graphTile", "dockerTile", "codeEditorTile",
  "settings", "tile-list", "agent-chat",
]);

// Buffer loading-done signal so it isn't lost if it arrives before
// React mounts and registers the onLoadingDone listener (race between
// did-finish-load firing and useEffect running).
let loadingDoneReceived = false;
ipcRenderer.on("shell:loading-done", () => {
  loadingDoneReceived = true;
});

// Buffer shell:forward messages that arrive before the renderer
// registers its onForwardToWebview callback (cold-launch race).
const pendingForwards: [string, string, ...unknown[]][] = [];
ipcRenderer.on("shell:forward", (_event, target, channel, ...args) => {
  pendingForwards.push([target, channel, ...args]);
});

contextBridge.exposeInMainWorld("shellApi", {
  getPlatform: (): NodeJS.Platform => process.platform,

  getViewConfig: (): Promise<AllViewConfigs> =>
    ipcRenderer.invoke("shell:get-view-config"),

  getPref: (key: string): Promise<unknown> =>
    ipcRenderer.invoke("pref:get", key),
  setPref: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke("pref:set", key, value),

  onForwardToWebview: (
    cb: (target: string, channel: string, ...args: unknown[]) => void,
  ) => {
    // Replay any messages that arrived before this callback registered
    for (const [target, channel, ...args] of pendingForwards) {
      cb(target, channel, ...args);
    }
    pendingForwards.length = 0;

    // Replace the buffer listener with the real handler
    ipcRenderer.removeAllListeners("shell:forward");
    const handler = (
      _event: unknown,
      target: string,
      channel: string,
      ...args: unknown[]
    ) => cb(target, channel, ...args);
    ipcRenderer.on("shell:forward", handler);
    return () => ipcRenderer.removeListener("shell:forward", handler);
  },

  onSettingsToggle: (cb: (action: "open" | "close") => void) => {
    const handler = (_event: unknown, action: "open" | "close") =>
      cb(action);
    ipcRenderer.on("shell:settings", handler);
    return () => ipcRenderer.removeListener("shell:settings", handler);
  },

  onLoadingStatus: (cb: (message: string) => void) => {
    const handler = (_event: unknown, message: string) => cb(message);
    ipcRenderer.on("shell:loading-status", handler);
    return () =>
      ipcRenderer.removeListener("shell:loading-status", handler);
  },

  onLoadingDone: (cb: () => void) => {
    if (loadingDoneReceived) {
      cb();
      return () => {};
    }
    const handler = () => {
      loadingDoneReceived = true;
      cb();
    };
    ipcRenderer.on("shell:loading-done", handler);
    return () =>
      ipcRenderer.removeListener("shell:loading-done", handler);
  },

  onShortcut: (cb: (action: string) => void) => {
    const handler = (_event: unknown, action: string) => cb(action);
    ipcRenderer.on("shell:shortcut", handler);
    return () =>
      ipcRenderer.removeListener("shell:shortcut", handler);
  },

  onAppFocused: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("shell:app-focused", handler);
    return () =>
      ipcRenderer.removeListener("shell:app-focused", handler);
  },

  onBrowserTileFocusUrl: (cb: (webContentsId: number) => void) => {
    const handler = (_event: unknown, id: number) => cb(id);
    ipcRenderer.on("browser-tile:focus-url", handler);
    return () =>
      ipcRenderer.removeListener("browser-tile:focus-url", handler);
  },

  onPrefChanged: (cb: (key: string, value: unknown) => void) => {
    const handler = (_event: unknown, key: string, value: unknown) =>
      cb(key, value);
    ipcRenderer.on("pref:changed", handler);
    return () => ipcRenderer.removeListener("pref:changed", handler);
  },

  openSettings: () => ipcRenderer.send("settings:open"),
  closeSettings: () => ipcRenderer.send("settings:close"),
  toggleSettings: () => ipcRenderer.send("settings:toggle"),

  logFromWebview: (
    panel: string,
    level: number,
    message: string,
    source: string,
  ) => {
    if (!ALLOWED_PANELS.has(panel)) return;
    ipcRenderer.send(
      "webview:console",
      panel,
      level,
      message,
      source,
    );
  },

  selectFile: (path: string) => ipcRenderer.send("nav:select-file", path),

  updateGetStatus: () => ipcRenderer.invoke("update:getStatus"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateDownload: () => ipcRenderer.invoke("update:download"),
  updateInstall: () => ipcRenderer.send("update:install"),
  onUpdateStatus: (cb: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => cb(state);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },

  vscodeServerUrl: (): Promise<{
    url?: string;
    token?: string;
    error?: string;
  }> => ipcRenderer.invoke("vscode:server-url"),

  canvasLoadState: () => ipcRenderer.invoke("canvas:load-state"),
  canvasSaveState: (state: unknown) =>
    ipcRenderer.invoke("canvas:save-state", state),

  workspaceMgrList: (): Promise<{
    activeId: string | null;
    workspaces: Array<{
      id: string;
      name: string;
      color: string;
      createdAt: number;
      lastFocusedAt: number;
    }>;
  }> => ipcRenderer.invoke("workspace-mgr:list"),
  workspaceMgrSetActive: (id: string) =>
    ipcRenderer.invoke("workspace-mgr:set-active", id),
  workspaceMgrCreate: (name?: string) =>
    ipcRenderer.invoke("workspace-mgr:create", name),
  workspaceMgrRename: (id: string, name: string) =>
    ipcRenderer.invoke("workspace-mgr:rename", id, name),
  workspaceMgrSetColor: (id: string, color: string) =>
    ipcRenderer.invoke("workspace-mgr:set-color", id, color),
  workspaceMgrDelete: (
    id: string,
  ): Promise<{ activeId: string | null; deleted: boolean }> =>
    ipcRenderer.invoke("workspace-mgr:delete", id),
  workspaceMgrReorder: (order: string[]) =>
    ipcRenderer.invoke("workspace-mgr:reorder", order),
  workspaceMgrListTabStates: (
    id: string,
  ): Promise<Array<{ tiles: Array<Record<string, unknown>> }>> =>
    ipcRenderer.invoke("workspace-mgr:list-tab-states", id),

  tabGet: (
    workspaceId: string,
  ): Promise<{
    activeTabId: string | null;
    tabs: Array<{ id: string; name: string }>;
  }> => ipcRenderer.invoke("tab:get", workspaceId),
  tabLoadState: (workspaceId: string, tabId: string) =>
    ipcRenderer.invoke("tab:load-state", workspaceId, tabId),
  tabSaveState: (workspaceId: string, tabId: string, state: unknown) =>
    ipcRenderer.invoke("tab:save-state", workspaceId, tabId, state),
  tabSetActive: (workspaceId: string, tabId: string) =>
    ipcRenderer.invoke("tab:set-active", workspaceId, tabId),
  tabCreate: (
    workspaceId: string,
    name?: string,
  ): Promise<{ id: string; name: string } | null> =>
    ipcRenderer.invoke("tab:create", workspaceId, name),
  tabRename: (workspaceId: string, tabId: string, name: string) =>
    ipcRenderer.invoke("tab:rename", workspaceId, tabId, name),
  tabDelete: (
    workspaceId: string,
    tabId: string,
  ): Promise<{ activeTabId: string | null; deleted: boolean }> =>
    ipcRenderer.invoke("tab:delete", workspaceId, tabId),

  getDragPaths: () => ipcRenderer.invoke("drag:get-paths"),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  isDirectory: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:is-directory", filePath),

  workspaceAdd: () => ipcRenderer.invoke("workspace:add"),
  workspaceRemove: (index: number) =>
    ipcRenderer.invoke("workspace:remove", index),
  workspaceList: () => ipcRenderer.invoke("workspace:list"),

  onWorkspaceAdded: (cb: (path: string) => void) => {
    const handler = (_event: unknown, path: string) => cb(path);
    ipcRenderer.on("workspace-added", handler);
    return () =>
      ipcRenderer.removeListener("workspace-added", handler);
  },
  onWorkspaceRemoved: (cb: (path: string) => void) => {
    const handler = (_event: unknown, path: string) => cb(path);
    ipcRenderer.on("workspace-removed", handler);
    return () =>
      ipcRenderer.removeListener("workspace-removed", handler);
  },

  onCanvasPinch: (cb: (deltaY: number) => void) => {
    const handler = (_event: unknown, deltaY: number) => cb(deltaY);
    ipcRenderer.on("canvas:pinch", handler);
    return () => ipcRenderer.removeListener("canvas:pinch", handler);
  },

  onCanvasTilePanStart: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("canvas:tile-pan-start", handler);
    return () =>
      ipcRenderer.removeListener("canvas:tile-pan-start", handler);
  },

  onCanvasRpcRequest: (
    cb: (request: { requestId: string; method: string; params: Record<string, unknown> }) => void,
  ) => {
    const handler = (
      _event: unknown,
      request: { requestId: string; method: string; params: Record<string, unknown> },
    ) => cb(request);
    ipcRenderer.on("canvas:rpc-request", handler);
    return () => ipcRenderer.removeListener("canvas:rpc-request", handler);
  },

  canvasRpcResponse: (response: {
    requestId: string;
    result?: unknown;
    error?: { code: number; message: string };
  }) => ipcRenderer.send("canvas:rpc-response", response),

  showConfirmDialog: (opts: {
    message: string;
    detail?: string;
    buttons?: string[];
  }): Promise<number> => ipcRenderer.invoke("dialog:confirm", opts),

  showContextMenu: (
    items: Array<{ id: string; label: string; enabled?: boolean }>,
  ) => ipcRenderer.invoke("context-menu:show", items),

  openExternal: (url: string) => ipcRenderer.send("shell:open-external", url),

  trackEvent: (name: string, properties?: Record<string, unknown>) => {
    ipcRenderer.send("analytics:track-event", name, properties);
  },

  // Integrations
  getAgents: () =>
    ipcRenderer.invoke("integrations:get-agents"),
  installSkill: (agentId: string) =>
    ipcRenderer.invoke("integrations:install-skill", agentId),
  hasOfferedPlugin: () =>
    ipcRenderer.invoke("integrations:has-offered-plugin"),
  markPluginOffered: () =>
    ipcRenderer.invoke("integrations:mark-plugin-offered"),

  getHomePath: (): string => ipcRenderer.sendSync("get-home-path"),

  agentResumeClear: (tileId: string) =>
    ipcRenderer.send("agent-resume:clear", tileId),

  windowMinimize: () => ipcRenderer.send("window:minimize"),
  windowMaximizeToggle: () => ipcRenderer.send("window:maximize-toggle"),
  windowClose: () => ipcRenderer.send("window:close"),
  windowIsMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke("window:is-maximized"),
  onWindowMaximizeChange: (cb: (maximized: boolean) => void) => {
    const handler = (_event: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("window:maximize-changed", handler);
    return () =>
      ipcRenderer.removeListener("window:maximize-changed", handler);
  },

  ptyKillSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("pty:kill", { sessionId }),

  ptyUpdateCwd: (sessionId: string, cwd: string): void => {
    ipcRenderer.send("pty:update-cwd", { sessionId, cwd });
  },

  ptyWrite: (sessionId: string, data: string): void => {
    ipcRenderer.send("pty:write", { sessionId, data });
  },

  ptyCapture: (
    sessionId: string, lines?: number,
  ): Promise<string> =>
    ipcRenderer.invoke("pty:capture", { sessionId, lines }),

  onPtyStatusChanged: (
    cb: (payload: { sessionId: string; foreground: string }) => void,
  ) => {
    const handler = (
      _event: unknown,
      payload: { sessionId: string; foreground: string },
    ) => cb(payload);
    ipcRenderer.on("pty:status-changed", handler);
    return () =>
      ipcRenderer.removeListener("pty:status-changed", handler);
  },

  onPtyExit: (
    cb: (payload: { sessionId: string; exitCode: number }) => void,
  ) => {
    const handler = (
      _event: unknown,
      payload: { sessionId: string; exitCode: number },
    ) => cb(payload);
    ipcRenderer.on("pty:exit", handler);
    return () =>
      ipcRenderer.removeListener("pty:exit", handler);
  },

  ptyDiscover: () => ipcRenderer.invoke("pty:discover"),

  browserNavigate: (
    webContentsId: number, url: string,
  ): Promise<{ url: string }> =>
    ipcRenderer.invoke("browser:navigate", { webContentsId, url }),

  browserScreenshot: (
    webContentsId: number,
  ): Promise<{ data: string }> =>
    ipcRenderer.invoke("browser:screenshot", { webContentsId }),

  browserSnapshot: (
    webContentsId: number,
  ): Promise<unknown> =>
    ipcRenderer.invoke("browser:snapshot", { webContentsId }),

  browserClick: (
    webContentsId: number, selector: string,
  ): Promise<void> =>
    ipcRenderer.invoke("browser:click", { webContentsId, selector }),

  browserType: (
    webContentsId: number, selector: string, text: string,
  ): Promise<void> =>
    ipcRenderer.invoke("browser:type", { webContentsId, selector, text }),

  // -- ACP agent forwarding --
  onAgentUpdate: (cb: (params: unknown) => void) => {
    const handler = (_event: unknown, params: unknown) =>
      cb(params);
    ipcRenderer.on("agent:update", handler);
    return () =>
      ipcRenderer.removeListener("agent:update", handler);
  },
  onAgentPromptComplete: (
    cb: (data: unknown) => void,
  ) => {
    const handler = (_event: unknown, data: unknown) =>
      cb(data);
    ipcRenderer.on("agent:prompt-complete", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:prompt-complete", handler,
      );
  },
  onAgentPromptError: (cb: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) =>
      cb(data);
    ipcRenderer.on("agent:prompt-error", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:prompt-error", handler,
      );
  },
  onAgentExit: (cb: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) =>
      cb(data);
    ipcRenderer.on("agent:exit", handler);
    return () =>
      ipcRenderer.removeListener("agent:exit", handler);
  },
  onAgentSessionReady: (cb: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) =>
      cb(data);
    ipcRenderer.on("agent:session-ready", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:session-ready", handler,
      );
  },
  onAgentSessionFailed: (cb: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) =>
      cb(data);
    ipcRenderer.on("agent:session-failed", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:session-failed", handler,
      );
  },

  browserScroll: (
    webContentsId: number, x: number, y: number,
  ): Promise<void> =>
    ipcRenderer.invoke("browser:scroll", { webContentsId, x, y }),

  browserEvaluate: (
    webContentsId: number, expression: string,
  ): Promise<{ value: unknown }> =>
    ipcRenderer.invoke(
      "browser:evaluate", { webContentsId, expression },
    ),

  browserWait: (
    webContentsId: number, timeout?: number,
  ): Promise<{ status: string }> =>
    ipcRenderer.invoke(
      "browser:wait", { webContentsId, timeout },
    ),

  browserInfo: (
    webContentsId: number,
  ): Promise<{
    url: string; title: string; loading: boolean;
    canGoBack: boolean; canGoForward: boolean;
  }> =>
    ipcRenderer.invoke("browser:info", { webContentsId }),

  notifyTileFocused: (
    data: string | null | { tileId: string | null; cwd: string | null },
  ) => ipcRenderer.send("shell:tile-focused", data),

  onNotificationNavigate: (
    cb: (data: { tileId: string | null; cwd: string | null }) => void,
  ) => {
    const handler = (_event: unknown, data: unknown) =>
      cb(data as never);
    ipcRenderer.on("shell:notification-navigate", handler);
    return () =>
      ipcRenderer.removeListener(
        "shell:notification-navigate",
        handler,
      );
  },

  onNotificationBadge: (
    cb: (data: { tileId: string | null; cwd: string | null }) => void,
  ) => {
    const handler = (_event: unknown, data: unknown) =>
      cb(data as never);
    ipcRenderer.on("shell:notification-badge", handler);
    return () =>
      ipcRenderer.removeListener(
        "shell:notification-badge",
        handler,
      );
  },
});
