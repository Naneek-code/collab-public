import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("notifApi", {
  onNotification: (
    cb: (data: {
      id: string;
      title: string;
      body: string;
      tileId: string | null;
    }) => void,
  ) => {
    const handler = (_event: unknown, data: unknown) => cb(data as never);
    ipcRenderer.on("notif:show", handler);
    return () => ipcRenderer.removeListener("notif:show", handler);
  },

  onDismiss: (cb: (data: { tileId: string }) => void) => {
    const handler = (_event: unknown, data: unknown) => cb(data as never);
    ipcRenderer.on("notif:dismiss", handler);
    return () => ipcRenderer.removeListener("notif:dismiss", handler);
  },

  notificationClicked: (data: {
    tileId: string | null;
    cwd: string | null;
  }) => ipcRenderer.send("notif:clicked", data),

  resize: (data: { height: number; empty: boolean }) =>
    ipcRenderer.send("notif:resize", data),

  onTheme: (cb: (dark: boolean) => void) => {
    const handler = (_event: unknown, dark: boolean) => cb(dark);
    ipcRenderer.on("notif:theme", handler);
    return () => ipcRenderer.removeListener("notif:theme", handler);
  },
});
