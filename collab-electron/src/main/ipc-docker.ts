import { ipcMain } from "electron";
import {
  checkAvailability,
  listContainers,
  startContainer,
  stopContainer,
  restartContainer,
  type DockerAvailability,
  type DockerContainer,
} from "./docker-manager";

export interface IpcDockerContext {
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
  trackEvent: (name: string, props?: Record<string, unknown>) => void;
}

interface MutationResult {
  ok: boolean;
  error?: string;
}

async function runMutation(
  fn: () => Promise<void>,
): Promise<MutationResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerDockerHandlers(ctx: IpcDockerContext): void {
  ipcMain.handle(
    "docker:available",
    (): Promise<DockerAvailability> => checkAvailability(),
  );

  ipcMain.handle("docker:list", async (): Promise<DockerContainer[]> => {
    try {
      return await listContainers();
    } catch {
      // The renderer treats an empty list + an availability check as "down".
      return [];
    }
  });

  ipcMain.handle(
    "docker:start",
    (_event, id: string) => runMutation(() => startContainer(id)),
  );
  ipcMain.handle(
    "docker:stop",
    (_event, id: string) => runMutation(() => stopContainer(id)),
  );
  ipcMain.handle(
    "docker:restart",
    (_event, id: string) => runMutation(() => restartContainer(id)),
  );

  // Forwarded from the nav / docker-tile windows to the canvas, which owns
  // tile creation. Mirrors the nav:open-in-terminal / nav:create-graph-tile
  // pattern in ipc-knowledge.ts.
  ipcMain.on(
    "docker:open-terminal",
    (_event, payload: { id: string; name: string }) => {
      ctx.trackEvent("docker_terminal_opened");
      ctx.forwardToWebview(
        "canvas",
        "open-docker-terminal",
        payload.id,
        payload.name,
      );
    },
  );

  ipcMain.on(
    "docker:open-logs",
    (_event, payload: { id: string; name: string }) => {
      ctx.trackEvent("docker_logs_opened");
      ctx.forwardToWebview(
        "canvas",
        "open-docker-logs",
        payload.id,
        payload.name,
      );
    },
  );

  ipcMain.on("docker:open-panel", () => {
    ctx.trackEvent("docker_panel_opened");
    ctx.forwardToWebview("canvas", "create-docker-tile");
  });
}
