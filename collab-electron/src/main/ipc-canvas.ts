import { ipcMain, type BrowserWindow } from "electron";
import * as workspaces from "./workspace-manager";

interface IpcContext {
  mainWindow: () => BrowserWindow | null;
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
}

export function registerCanvasHandlers(
  ctx: IpcContext,
): void {
  let pendingDragPaths: string[] = [];

  // Canvas persistence (operates on the active workspace)
  ipcMain.handle(
    "canvas:load-state",
    async () => workspaces.loadActiveState(),
  );

  ipcMain.handle(
    "canvas:save-state",
    async (_event, state) => workspaces.saveActiveState(state),
  );

  // Workspace management
  ipcMain.handle(
    "workspace-mgr:list",
    async () => workspaces.listWorkspaces(),
  );

  ipcMain.handle(
    "workspace-mgr:set-active",
    async (_event, id: string) => workspaces.setActiveWorkspace(id),
  );

  ipcMain.handle(
    "workspace-mgr:create",
    async (_event, name?: string) => workspaces.createWorkspace(name),
  );

  ipcMain.handle(
    "workspace-mgr:rename",
    async (_event, id: string, name: string) =>
      workspaces.renameWorkspace(id, name),
  );

  ipcMain.handle(
    "workspace-mgr:set-color",
    async (_event, id: string, color: string) =>
      workspaces.setColor(id, color),
  );

  ipcMain.handle(
    "workspace-mgr:delete",
    async (_event, id: string) => workspaces.deleteWorkspace(id),
  );

  ipcMain.handle(
    "workspace-mgr:reorder",
    async (_event, order: string[]) =>
      workspaces.reorderWorkspaces(order),
  );

  ipcMain.handle(
    "workspace-mgr:list-tab-states",
    async (_event, id: string) => workspaces.listTabStates(id),
  );

  // Tab management (within a workspace)
  ipcMain.handle(
    "tab:get",
    async (_event, workspaceId: string) => workspaces.getTabs(workspaceId),
  );

  ipcMain.handle(
    "tab:load-state",
    async (_event, workspaceId: string, tabId: string) =>
      workspaces.loadTabState(workspaceId, tabId),
  );

  ipcMain.handle(
    "tab:save-state",
    async (_event, workspaceId: string, tabId: string, state) =>
      workspaces.saveTabState(workspaceId, tabId, state),
  );

  ipcMain.handle(
    "tab:set-active",
    async (_event, workspaceId: string, tabId: string) =>
      workspaces.setActiveTab(workspaceId, tabId),
  );

  ipcMain.handle(
    "tab:create",
    async (_event, workspaceId: string, name?: string) =>
      workspaces.createTab(workspaceId, name),
  );

  ipcMain.handle(
    "tab:rename",
    async (_event, workspaceId: string, tabId: string, name: string) =>
      workspaces.renameTab(workspaceId, tabId, name),
  );

  ipcMain.handle(
    "tab:delete",
    async (_event, workspaceId: string, tabId: string) =>
      workspaces.deleteTab(workspaceId, tabId),
  );

  // Canvas pinch forwarding
  ipcMain.on(
    "canvas:forward-pinch",
    (_event, deltaY: number) => {
      ctx
        .mainWindow()
        ?.webContents.send("canvas:pinch", deltaY);
    },
  );

  // Middle-button pan forwarding from tile webviews
  ipcMain.on(
    "canvas:tile-pan-start",
    () => {
      ctx
        .mainWindow()
        ?.webContents.send("canvas:tile-pan-start");
    },
  );

  // Cross-webview drag-and-drop
  ipcMain.on(
    "drag:set-paths",
    (_event, paths: string[]) => {
      pendingDragPaths = paths;
      ctx.forwardToWebview(
        "viewer",
        "nav-drag-active",
        true,
      );
    },
  );

  ipcMain.on("drag:clear-paths", () => {
    pendingDragPaths = [];
    ctx.forwardToWebview(
      "viewer",
      "nav-drag-active",
      false,
    );
  });

  ipcMain.handle("drag:get-paths", () => {
    const paths = pendingDragPaths;
    pendingDragPaths = [];
    return paths;
  });
}
