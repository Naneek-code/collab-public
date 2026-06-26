import { execFileSync, spawn } from "node:child_process";

/**
 * Detect installed code editors (VS Code and compatible forks) and open
 * folders in them. All supported editors share the VS Code CLI surface, so a
 * single `<cmd> -n <folder>` invocation works across the board.
 */

export interface IdeInfo {
  /** Stable id used over IPC, e.g. "vscode". */
  id: string;
  /** Human label shown in menus, e.g. "VS Code". */
  label: string;
  /** CLI command resolved from PATH. */
  command: string;
}

interface IdeDef {
  id: string;
  label: string;
  command: string;
}

// Preference order: the first installed editor becomes the default.
const KNOWN_IDES: IdeDef[] = [
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "windsurf", label: "Windsurf", command: "windsurf" },
  { id: "vscode-insiders", label: "VS Code Insiders", command: "code-insiders" },
  { id: "vscodium", label: "VSCodium", command: "codium" },
];

function commandExists(command: string): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      { encoding: "utf8", stdio: "ignore", timeout: 5000, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

let cache: IdeInfo[] | null = null;

/** All detected editors, in preference order. Result is cached per process. */
export function detectIdes(): IdeInfo[] {
  if (cache) return cache;
  cache = KNOWN_IDES.filter((ide) => commandExists(ide.command)).map((ide) => ({
    id: ide.id,
    label: ide.label,
    command: ide.command,
  }));
  return cache;
}

export function getDefaultIde(): IdeInfo | null {
  return detectIdes()[0] ?? null;
}

/**
 * Open a folder in the given editor (or the default if id is omitted) in a new
 * window. We launch through a shell so Windows resolves the editor's `.cmd`
 * shim from PATH; the folder path is quoted to tolerate spaces.
 */
export function openInIde(folderPath: string, ideId?: string): boolean {
  const ides = detectIdes();
  const ide = ideId ? ides.find((i) => i.id === ideId) : ides[0];
  if (!ide) return false;

  const safePath = folderPath.replace(/"/g, '\\"');
  const commandLine = `${ide.command} -n "${safePath}"`;

  const child = spawn(commandLine, {
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (err) => {
    console.error(`[ide] failed to launch ${ide.command}:`, err);
  });
  child.unref();
  return true;
}
