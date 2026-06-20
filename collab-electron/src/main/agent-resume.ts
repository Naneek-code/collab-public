import { ipcMain } from "electron";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  watchFile,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { COLLAB_DIR } from "./paths";
import { listLiveSidecarSessions } from "./pty";

const AGENT_DIR = join(COLLAB_DIR, "agent-events");
const EVENTS_FILE = join(AGENT_DIR, "events.jsonl");
const SCRIPT_PATH = join(COLLAB_DIR, "agent-session-report.cjs");
const BINDINGS_DIR = join(COLLAB_DIR, "agent-bindings");

export type AgentKind = "claude" | "codex";

export interface AgentBinding {
  agentSessionId: string;
  agentKind: AgentKind;
  cwd: string | null;
  updatedAt: number;
  tileId?: string;
}

interface AgentEvent {
  kind?: string;
  ppid?: number;
  tileId?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  source?: string | null;
  event?: string | null;
  ts?: number;
}

// Hook script: receives the agent's SessionStart JSON on stdin, records the
// session id together with its own parent pid (the agent process) so the app
// can map it back to the owning terminal tile via process ancestry.
const REPORT_SCRIPT = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const eventsFile = process.argv[2];
const kind = process.argv[3] || "claude";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  try {
    const evt = JSON.parse(input || "{}");
    const record = {
      kind,
      ppid: process.ppid,
      tileId: process.env.COLLAB_TILE_ID || null,
      sessionId: evt.session_id || null,
      cwd: evt.cwd || null,
      source: evt.source || null,
      event: evt.hook_event_name || null,
      ts: Date.now(),
    };
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify(record) + "\\n");
  } catch (_e) {}
  process.exit(0);
});
const safety = setTimeout(() => process.exit(0), 5000);
if (safety.unref) safety.unref();
`;

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function ensureDirs(): void {
  try {
    mkdirSync(AGENT_DIR, { recursive: true });
    mkdirSync(BINDINGS_DIR, { recursive: true });
  } catch {}
}

function writeReportScript(): void {
  try {
    writeFileSync(SCRIPT_PATH, REPORT_SCRIPT, "utf8");
  } catch {}
}

function hookCommand(kind: AgentKind): string {
  // Relies on `node` being on PATH — true for any machine with the agent CLIs
  // installed via npm. Standalone-binary installs may need a different launcher.
  return `node "${SCRIPT_PATH}" "${EVENTS_FILE}" ${kind}`;
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

function mergeHookSettings(
  file: string,
  command: string,
  events: string[],
): void {
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      json = parsed as Record<string, unknown>;
    }
  } catch {}

  const hooks = (json.hooks && typeof json.hooks === "object"
    ? json.hooks
    : {}) as Record<string, HookEntry[]>;

  for (const ev of events) {
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    // Drop any prior entry that references our script, then add the fresh one.
    const cleaned = arr.filter(
      (entry) =>
        !(entry?.hooks ?? []).some(
          (h) =>
            typeof h?.command === "string" &&
            h.command.includes(SCRIPT_PATH),
        ),
    );
    cleaned.push({ hooks: [{ type: "command", command }] });
    hooks[ev] = cleaned;
  }

  json.hooks = hooks;

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
  } catch {}
}

function installHooks(): void {
  const home = homedir();

  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) {
    mergeHookSettings(
      join(claudeDir, "settings.json"),
      hookCommand("claude"),
      ["SessionStart", "SessionEnd"],
    );
  }

  const codexDir = join(home, ".codex");
  if (existsSync(codexDir)) {
    mergeHookSettings(
      join(codexDir, "hooks.json"),
      hookCommand("codex"),
      ["SessionStart"],
    );
  }
}

function getParentPid(pid: number): number {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
        ],
        { encoding: "utf8", timeout: 2000, windowsHide: true },
      ).trim();
      return parseInt(out, 10) || 0;
    }
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

// Walk up the process tree from the hook's parent (the agent process) until we
// reach a pid that matches a live terminal session's PTY shell. That session's
// tile owns the agent — unambiguous even with two agents in the same folder.
async function resolveTileId(startPpid: number): Promise<string | null> {
  const live = await listLiveSidecarSessions();
  const byPid = new Map<number, string>();
  for (const s of live) {
    if (s.tileId) byPid.set(s.pid, s.tileId);
  }
  if (byPid.size === 0) return null;

  let pid = startPpid;
  let hops = 0;
  while (pid && pid > 1 && hops < 12) {
    const tileId = byPid.get(pid);
    if (tileId) return tileId;
    pid = getParentPid(pid);
    hops++;
  }
  return null;
}

function bindingPath(tileId: string): string {
  return join(BINDINGS_DIR, `${safeKey(tileId)}.json`);
}

function writeBinding(tileId: string, binding: AgentBinding): void {
  try {
    mkdirSync(BINDINGS_DIR, { recursive: true });
    writeFileSync(bindingPath(tileId), JSON.stringify(binding), "utf8");
  } catch {}
}

export function getBinding(tileId: string): AgentBinding | null {
  try {
    const raw = readFileSync(bindingPath(tileId), "utf8");
    const parsed = JSON.parse(raw) as AgentBinding;
    if (parsed && typeof parsed.agentSessionId === "string") return parsed;
  } catch {}
  return null;
}

export function getTileIdBySession(agentSessionId: string): string | null {
  try {
    for (const file of readdirSync(BINDINGS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          readFileSync(join(BINDINGS_DIR, file), "utf8"),
        ) as AgentBinding;
        if (parsed?.agentSessionId === agentSessionId && parsed.tileId) {
          return parsed.tileId;
        }
      } catch {}
    }
  } catch {}
  return null;
}

export function clearBinding(tileId: string): void {
  try {
    unlinkSync(bindingPath(tileId));
  } catch {}
}

async function handleEvent(rec: AgentEvent): Promise<void> {
  if (!rec.sessionId) return;
  const tileId = rec.tileId
    ?? (rec.ppid ? await resolveTileId(rec.ppid) : null);
  if (!tileId) return;
  writeBinding(tileId, {
    agentSessionId: rec.sessionId,
    agentKind: rec.kind === "codex" ? "codex" : "claude",
    cwd: rec.cwd ?? null,
    updatedAt: rec.ts ?? Date.now(),
    tileId,
  });
}

let readOffset = 0;

function processNewEvents(): void {
  let size: number;
  try {
    size = statSync(EVENTS_FILE).size;
  } catch {
    return;
  }
  if (size < readOffset) readOffset = 0; // file truncated/rotated
  if (size === readOffset) return;

  let chunk: Buffer;
  try {
    const fd = openSync(EVENTS_FILE, "r");
    chunk = Buffer.alloc(size - readOffset);
    readSync(fd, chunk, 0, chunk.length, readOffset);
    closeSync(fd);
  } catch {
    return;
  }
  readOffset = size;

  for (const line of chunk.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      void handleEvent(JSON.parse(line) as AgentEvent);
    } catch {}
  }
}

function startWatching(): void {
  ensureDirs();
  try {
    if (!existsSync(EVENTS_FILE)) appendFileSync(EVENTS_FILE, "");
    readOffset = statSync(EVENTS_FILE).size; // ignore pre-existing lines
  } catch {
    readOffset = 0;
  }
  watchFile(EVENTS_FILE, { interval: 500 }, () => processNewEvents());
}

export function initAgentResume(): void {
  ensureDirs();
  writeReportScript();
  installHooks();
  startWatching();
}

export function registerAgentResumeIpc(): void {
  ipcMain.handle("agent-resume:get", (_event, tileId: string) =>
    typeof tileId === "string" ? getBinding(tileId) : null,
  );
  ipcMain.on("agent-resume:clear", (_event, tileId: string) => {
    if (typeof tileId === "string") clearBinding(tileId);
  });
}
