import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { type BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { COLLAB_DIR } from "./paths";
import { PROBE_STATE_DIR } from "./claude-statusline";
import { getBinding, getTileIdBySession } from "./agent-resume";
import { listLiveSidecarSessions } from "./pty";
import { showOverlayNotification } from "./notification-overlay";

export interface ClaudeStructuredState {
  model?: string;
  mode?: string;
  permissionMode?: string;
  status?: string;
  contextTokens?: number;
  defaultModel?: string;
  contextWindowSize?: number;
  usedPercentage?: number;
}

function usageTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, number>;
  const sum =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  return sum > 0 ? sum : undefined;
}

// Native data from the statusline probe (when enabled): authoritative model id
// and exact context window size + used percentage. Overrides transcript guesses.
function readProbeState(session: TrackedSession): boolean {
  const file = join(PROBE_STATE_DIR, `${session.agentSessionId}.json`);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  let changed = false;
  const set = <K extends keyof ClaudeStructuredState>(
    key: K,
    value: ClaudeStructuredState[K] | undefined,
  ) => {
    if (value != null && value !== session.state[key]) {
      session.state[key] = value;
      changed = true;
    }
  };

  const model = data.model as { id?: string } | undefined;
  set("model", typeof model?.id === "string" ? model.id : undefined);

  const cw = data.context_window as Record<string, unknown> | undefined;
  if (cw) {
    set(
      "contextWindowSize",
      typeof cw.context_window_size === "number" ? cw.context_window_size : undefined,
    );
    set(
      "usedPercentage",
      typeof cw.used_percentage === "number" ? cw.used_percentage : undefined,
    );
    set(
      "contextTokens",
      typeof cw.total_input_tokens === "number" ? cw.total_input_tokens : undefined,
    );
  }
  return changed;
}

const CLAUDE_DIR = join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const BINDINGS_DIR = join(COLLAB_DIR, "agent-bindings");

const POLL_MS = 800;
const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

function readDefaultModel(): string | undefined {
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf8");
    const model = JSON.parse(raw)?.model;
    return typeof model === "string" && model ? model : undefined;
  } catch {
    return undefined;
  }
}

function cwdToSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

function findTranscriptPath(
  sessionId: string,
  cwd: string | null,
): string | null {
  if (cwd) {
    const slug = cwdToSlug(cwd);
    const direct = join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const dir of readdirSync(PROJECTS_DIR)) {
      const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function findSessionFile(agentSessionId: string): string | null {
  try {
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const full = join(SESSIONS_DIR, file);
      const raw = readFileSync(full, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.sessionId === agentSessionId) return full;
    }
  } catch {}
  return null;
}

interface TrackedSession {
  ptySessionId: string;
  tileId: string;
  agentSessionId: string;
  transcriptPath: string | null;
  transcriptOffset: number;
  sessionFilePath: string | null;
  state: ClaudeStructuredState;
}

let mainWindow: BrowserWindow | null = null;
const tracked = new Map<string, TrackedSession>();

function sendState(
  ptySessionId: string,
  state: ClaudeStructuredState,
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("claude:state", {
      ptySessionId,
      ...state,
    });
  }
}

function readNewTranscriptLines(session: TrackedSession): void {
  if (!session.transcriptPath) return;

  let size: number;
  try {
    size = statSync(session.transcriptPath).size;
  } catch {
    return;
  }
  if (size <= session.transcriptOffset) {
    if (size < session.transcriptOffset) session.transcriptOffset = 0;
    return;
  }

  let chunk: Buffer;
  try {
    const fd = openSync(session.transcriptPath, "r");
    chunk = Buffer.alloc(size - session.transcriptOffset);
    readSync(fd, chunk, 0, chunk.length, session.transcriptOffset);
    closeSync(fd);
  } catch {
    return;
  }
  session.transcriptOffset = size;

  let changed = false;
  for (const line of chunk.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "mode" && typeof entry.mode === "string") {
        session.state.mode = entry.mode;
        changed = true;
      }
      if (
        entry.type === "permission-mode" &&
        typeof entry.permissionMode === "string"
      ) {
        session.state.permissionMode = entry.permissionMode;
        changed = true;
      }
      if (entry.message?.model && entry.message?.role === "assistant") {
        session.state.model = entry.message.model;
        changed = true;
      }
      if (entry.message?.role === "assistant" && entry.message?.usage) {
        const tokens = usageTokens(entry.message.usage);
        if (tokens != null && tokens !== session.state.contextTokens) {
          session.state.contextTokens = tokens;
          changed = true;
        }
      }
    } catch {}
  }
  if (changed) sendState(session.ptySessionId, session.state);
}

function readSessionStatus(session: TrackedSession): void {
  if (!session.sessionFilePath) {
    session.sessionFilePath = findSessionFile(session.agentSessionId);
    if (!session.sessionFilePath) return;
  }

  try {
    const raw = readFileSync(session.sessionFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.status && parsed.status !== session.state.status) {
      session.state.status = parsed.status;
      sendState(session.ptySessionId, session.state);
    }
  } catch {}
}

function initTranscriptState(session: TrackedSession): void {
  if (!session.transcriptPath) return;

  try {
    const raw = readFileSync(session.transcriptPath, "utf8");
    const lines = raw.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (
          !session.state.mode &&
          entry.type === "mode" &&
          typeof entry.mode === "string"
        ) {
          session.state.mode = entry.mode;
        }
        if (
          !session.state.permissionMode &&
          entry.type === "permission-mode" &&
          typeof entry.permissionMode === "string"
        ) {
          session.state.permissionMode = entry.permissionMode;
        }
        if (
          !session.state.model &&
          entry.message?.model &&
          entry.message?.role === "assistant"
        ) {
          session.state.model = entry.message.model;
        }
        if (
          session.state.contextTokens == null &&
          entry.message?.role === "assistant"
        ) {
          const tokens = usageTokens(entry.message.usage);
          if (tokens != null) session.state.contextTokens = tokens;
        }
      } catch {}
      if (
        session.state.mode &&
        session.state.model &&
        session.state.permissionMode &&
        session.state.contextTokens != null
      ) {
        break;
      }
    }

    session.transcriptOffset = Buffer.byteLength(raw, "utf8");
  } catch {}
}

async function syncSessions(): Promise<void> {
  let sidecarSessions: Array<{
    sessionId: string;
    pid: number;
    tileId?: string;
  }>;
  try {
    sidecarSessions = await listLiveSidecarSessions();
  } catch {
    return;
  }

  const activePtyIds = new Set<string>();

  for (const sc of sidecarSessions) {
    if (!sc.tileId) continue;
    activePtyIds.add(sc.sessionId);

    if (tracked.has(sc.sessionId)) continue;

    const binding = getBinding(sc.tileId);
    if (!binding?.agentSessionId) continue;
    if (binding.agentKind !== "claude") continue;

    const transcriptPath = findTranscriptPath(
      binding.agentSessionId,
      binding.cwd,
    );

    const session: TrackedSession = {
      ptySessionId: sc.sessionId,
      tileId: sc.tileId,
      agentSessionId: binding.agentSessionId,
      transcriptPath,
      transcriptOffset: 0,
      sessionFilePath: null,
      state: {},
    };

    tracked.set(sc.sessionId, session);
    initTranscriptState(session);
    readSessionStatus(session);
    if (
      session.state.model ||
      session.state.mode ||
      session.state.status
    ) {
      sendState(sc.sessionId, session.state);
    }
  }

  for (const [ptyId] of tracked) {
    if (!activePtyIds.has(ptyId)) {
      tracked.delete(ptyId);
    }
  }
}

async function pollAll(): Promise<void> {
  await syncSessions();
  for (const session of tracked.values()) {
    if (!session.transcriptPath) {
      const binding = getBinding(session.tileId);
      if (binding?.cwd) {
        session.transcriptPath = findTranscriptPath(
          session.agentSessionId,
          binding.cwd,
        );
        if (session.transcriptPath) initTranscriptState(session);
      }
    }
    readNewTranscriptLines(session);
    readSessionStatus(session);
    if (readProbeState(session)) sendState(session.ptySessionId, session.state);
    const def = readDefaultModel();
    let changed = false;
    if (def && def !== session.state.defaultModel) {
      session.state.defaultModel = def;
      changed = true;
    }
    if (!session.state.model && def) {
      session.state.model = def;
      changed = true;
    }
    if (changed) sendState(session.ptySessionId, session.state);
  }
}

export function getTileIdForPty(ptySessionId: string): string | null {
  return tracked.get(ptySessionId)?.tileId ?? null;
}

const directTracked = new Map<
  string,
  { status: string }
>();

function pollClaudeSessionFiles(): void {
  if (!existsSync(SESSIONS_DIR)) return;

  const activePids = new Set<string>();

  try {
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const full = join(SESSIONS_DIR, file);
      try {
        const raw = readFileSync(full, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed?.status || !parsed?.pid) continue;

        const key = String(parsed.pid);
        activePids.add(key);
        const prev = directTracked.get(key);

        if (prev && prev.status !== parsed.status) {
          const cwd: string | null = parsed.cwd ?? null;
          const title = cwd
            ? cwd.replace(/\\/g, "/").split("/").pop() ?? "Terminal"
            : "Terminal";
          const tileId = parsed.sessionId
            ? getTileIdBySession(parsed.sessionId)
            : null;

          if (prev.status === "busy" && parsed.status === "idle") {
            showOverlayNotification({
              title,
              body: "Claude finished",
              tileId,
              cwd,
              sound: "finished",
            });
          } else if (parsed.status === "waiting") {
            showOverlayNotification({
              title,
              body: "Claude needs your attention",
              tileId,
              cwd,
              sound: "attention",
            });
          }
        }
        directTracked.set(key, { status: parsed.status });
      } catch {}
    }
  } catch {}

  for (const [pid] of directTracked) {
    if (!activePids.has(pid)) directTracked.delete(pid);
  }
}

export function initClaudeState(window: BrowserWindow): void {
  mainWindow = window;

  ipcMain.handle(
    "claude:get-state",
    (_event, ptySessionId: string): ClaudeStructuredState | null => {
      const session = tracked.get(ptySessionId);
      return session?.state ?? null;
    },
  );

  if (!existsSync(CLAUDE_DIR)) return;

  void pollAll();
  pollClaudeSessionFiles();
  const timer = setInterval(() => {
    void pollAll();
    pollClaudeSessionFiles();
  }, POLL_MS);

  mainWindow.on("closed", () => {
    clearInterval(timer);
    mainWindow = null;
  });
}
