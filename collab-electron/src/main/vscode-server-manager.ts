import { session } from "electron";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import * as http from "node:http";
import * as net from "node:net";

const PARTITION = "persist:vscode";
const RESET_FLAG = join(homedir(), ".collaborator", ".vscode-web-reset-v1");

// Secret required on every request. The server binds to loopback only (so it is
// never reachable off-machine), and this token additionally blocks other local
// processes from connecting. Only this app knows it; it's put in the tile URL.
const CONNECTION_TOKEN = randomBytes(24).toString("hex");

// Dedicated data dir for the embedded server. Seeded from the installed VS Code
// so the embedded editor shares the same settings/keybindings/extensions. Kept
// separate from the desktop's own dir to avoid "directory in use" conflicts.
const SERVER_DATA_DIR = join(homedir(), ".collaborator", "vscode-web");

function desktopUserDir(): string | null {
  if (process.platform === "win32") {
    return process.env.APPDATA
      ? join(process.env.APPDATA, "Code", "User")
      : null;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User");
  }
  return join(homedir(), ".config", "Code", "User");
}

/**
 * Copy the user's installed-VS-Code settings, keybindings and snippets into the
 * embedded server's data dir so it looks like their real editor.
 *
 * Extensions are intentionally NOT copied: desktop extensions (especially
 * language packs) are often incompatible with the web/server host and break the
 * UI (untranslated `{0}` placeholders, files failing to open). Users can install
 * web-compatible extensions from inside the embedded editor instead.
 */
/**
 * Insert a settings key right after the opening brace if it isn't already set.
 * Works for both JSON and JSONC (comments) since it only prepends a member.
 */
function ensureSetting(file: string, key: string, jsonValue: string): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (content.includes(`"${key}"`)) return;
  const brace = content.indexOf("{");
  if (brace === -1) {
    content = `{\n  "${key}": ${jsonValue}\n}\n`;
  } else {
    content =
      content.slice(0, brace + 1) +
      `\n  "${key}": ${jsonValue},` +
      content.slice(brace + 1);
  }
  writeFileSync(file, content);
}

function seedFromDesktop(): void {
  try {
    const userDst = join(SERVER_DATA_DIR, "data", "User");
    mkdirSync(userDst, { recursive: true });
    const userSrc = desktopUserDir();
    if (userSrc && existsSync(userSrc)) {
      for (const file of ["settings.json", "keybindings.json"]) {
        const src = join(userSrc, file);
        if (existsSync(src)) copyFileSync(src, join(userDst, file));
      }
      const snippets = join(userSrc, "snippets");
      if (existsSync(snippets)) {
        cpSync(snippets, join(userDst, "snippets"), { recursive: true });
      }
    }
    const settingsFile = join(userDst, "settings.json");
    // The embedded editor only ever opens the user's own folders, so skip the
    // "do you trust the authors" prompt.
    ensureSetting(settingsFile, "security.workspace.trust.enabled", "false");
    // Default to a dark theme (only if the user hasn't chosen one).
    ensureSetting(settingsFile, "workbench.colorTheme", '"Default Dark Modern"');
  } catch (err) {
    console.warn("[vscode-server] could not seed config from desktop:", err);
  }
}

/**
 * Clear the embedded editor's browser partition once. Recovers installs whose
 * cache holds a half-applied language pack (untranslated `{0}` placeholders)
 * from before extensions were dropped.
 */
export async function resetPartitionOnce(): Promise<void> {
  try {
    if (existsSync(RESET_FLAG)) return;
    const sess = session.fromPartition(PARTITION);
    await sess.clearStorageData();
    await sess.clearCache();
    mkdirSync(dirname(RESET_FLAG), { recursive: true });
    writeFileSync(RESET_FLAG, "1");
    console.log("[vscode-server] cleared partition cache (one-time)");
  } catch (err) {
    console.warn("[vscode-server] partition reset failed:", err);
  }
}

/**
 * Runs the real, open-source VS Code web build so a tile can embed the full
 * editor (Git, diffs, Settings, Search — everything). A SINGLE server is kept
 * warm for the whole app: `code serve-web` serves any folder via the `?folder=`
 * URL param, so one instance backs every tile. It is pre-warmed at boot so the
 * first tile opens fast, and reused afterwards.
 */

type Kind = "vscode-cli" | "code-server" | "openvscode-server";

interface ServerBinary {
  command: string;
  kind: Kind;
}

/**
 * Resolve a command to its absolute path. Spawning the absolute path (rather
 * than the bare name) avoids PATH-resolution failures: when the app is launched
 * from Git Bash, the inherited PATH is in Unix form and cmd.exe can't resolve
 * bare commands from it, so `code serve-web` would silently fail.
 */
function resolveCommand(command: string): string | null {
  try {
    const out = execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // Prefer an executable launcher (.cmd/.exe) when several are returned.
    const preferred = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l));
    return preferred ?? lines[0] ?? null;
  } catch {
    return null;
  }
}

let binaryCache: ServerBinary | null | undefined;

function findBinary(): ServerBinary | null {
  if (binaryCache !== undefined) return binaryCache;
  // Prefer the built-in `code serve-web` (most reliable, esp. on Windows where
  // the npm code-server shim is often broken); fall back to dedicated servers.
  const candidates: Array<{ name: string; kind: Kind }> = [
    { name: "code", kind: "vscode-cli" },
    { name: "code-insiders", kind: "vscode-cli" },
    { name: "cursor", kind: "vscode-cli" },
    { name: "windsurf", kind: "vscode-cli" },
    { name: "codium", kind: "vscode-cli" },
    { name: "code-server", kind: "code-server" },
    { name: "openvscode-server", kind: "openvscode-server" },
  ];
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate.name);
    if (resolved) {
      binaryCache = { command: resolved, kind: candidate.kind };
      console.log(
        `[vscode-server] using ${candidate.kind} at ${resolved}`,
      );
      return binaryCache;
    }
  }
  console.warn("[vscode-server] no VS Code server binary found on PATH");
  binaryCache = null;
  return null;
}

export function isAvailable(): boolean {
  return findBinary() !== null;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ping(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 2000 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealthy(port: number, timeoutMs = 120000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping(port)) return true;
    await delay(400);
  }
  return false;
}

function buildArgs(kind: Kind, port: number): string[] {
  if (kind === "vscode-cli") {
    return [
      "serve-web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--connection-token",
      CONNECTION_TOKEN,
      "--server-data-dir",
      SERVER_DATA_DIR,
      "--accept-server-license-terms",
    ];
  }
  if (kind === "openvscode-server") {
    return [
      "--connection-token",
      CONNECTION_TOKEN,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
  }
  return ["--bind-addr", `127.0.0.1:${port}`, "--auth", "none"];
}

interface RunningServer {
  child: ChildProcess;
  port: number;
  url: string;
  token: string;
}

/** The connection token for the running server (empty if it uses none). */
export function getToken(): string {
  return server?.token ?? "";
}

let server: RunningServer | null = null;
let starting: Promise<string> | null = null;

/** Ensure the shared VS Code web server is running; returns its base URL. */
export function ensureServer(): Promise<string> {
  if (server && server.child.exitCode === null) {
    return Promise.resolve(server.url);
  }
  if (starting) return starting;

  const bin = findBinary();
  if (!bin) {
    return Promise.reject(
      new Error(
        "VS Code not found. Install VS Code and the `code` command (Command Palette → Shell Command: Install 'code' in PATH).",
      ),
    );
  }

  starting = (async () => {
    if (bin.kind === "vscode-cli") seedFromDesktop();
    const port = await getFreePort();
    const args = buildArgs(bin.kind, port);
    const cmdLine = [bin.command, ...args]
      .map((a) => (/\s/.test(a) ? `"${a}"` : a))
      .join(" ");
    console.log(`[vscode-server] starting on :${port} -> ${cmdLine}`);
    const child = spawn(cmdLine, {
      shell: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.on("error", (err) => console.error("[vscode-server] spawn:", err));
    child.on("exit", (code) => {
      console.log(`[vscode-server] process exited code=${code}`);
      if (server?.child === child) server = null;
    });

    const healthy = await waitForHealthy(port);
    if (!healthy) {
      console.error("[vscode-server] did not become healthy in time");
      stopChild(child);
      starting = null;
      throw new Error("VS Code server did not start in time.");
    }
    console.log(`[vscode-server] healthy at http://127.0.0.1:${port}`);
    server = {
      child,
      port,
      url: `http://127.0.0.1:${port}`,
      token: bin.kind === "code-server" ? "" : CONNECTION_TOKEN,
    };
    starting = null;
    return server.url;
  })();

  return starting;
}

/** Kick off the server in the background so the first tile opens fast. */
export function prewarm(): void {
  if (!isAvailable()) return;
  ensureServer().catch(() => {});
}

function stopChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      child.kill();
    }
  } else {
    child.kill();
  }
}

export function stopAll(): void {
  if (server) stopChild(server.child);
  server = null;
  starting = null;
}
