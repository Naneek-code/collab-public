import { ipcMain } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Backend for the lightweight VS Code-like editor tile: git status for the
 * Source Control view and a recursive filename search for the Search view.
 */

const execFileAsync = promisify(execFile);

export interface GitFileChange {
  path: string;
  /** Staged (index) status char, e.g. "M", "A", " ". */
  index: string;
  /** Unstaged (worktree) status char, e.g. "M", "?", " ". */
  worktree: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  error?: string;
}

function git(folder: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd: folder,
    timeout: 12000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function gitStatus(folder: string): Promise<GitStatus> {
  try {
    const out = await git(folder, ["status", "--porcelain=v1", "--branch"]);
    const lines = out.stdout.split(/\r?\n/);
    let branch = "";
    let ahead = 0;
    let behind = 0;
    const files: GitFileChange[] = [];
    for (const line of lines) {
      if (line.startsWith("## ")) {
        // e.g. "## main...origin/main [ahead 1, behind 2]"
        const head = line.slice(3);
        branch = head.split("...")[0]?.split(" ")[0] ?? "";
        const aheadM = head.match(/ahead (\d+)/);
        const behindM = head.match(/behind (\d+)/);
        if (aheadM) ahead = Number(aheadM[1]);
        if (behindM) behind = Number(behindM[1]);
        continue;
      }
      if (line.length < 4) continue;
      files.push({
        index: line[0] ?? " ",
        worktree: line[1] ?? " ",
        path: line.slice(3),
      });
    }
    return { isRepo: true, branch, ahead, behind, files };
  } catch (err) {
    return {
      isRepo: false,
      branch: "",
      ahead: 0,
      behind: 0,
      files: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface GitResult {
  ok: boolean;
  error?: string;
}

async function gitRun(folder: string, args: string[]): Promise<GitResult> {
  try {
    await git(folder, args);
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || "git failed").trim() };
  }
}

const SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "target",
  "build",
  ".next",
  ".cache",
  ".venv",
]);

async function findFiles(
  root: string,
  query: string,
  limit = 200,
): Promise<string[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().includes(q)) {
        results.push(join(dir, entry.name));
      }
    }
  }

  await walk(root);
  return results;
}

export function registerEditorHandlers(): void {
  ipcMain.handle(
    "editor:git-status",
    (_event, folder: string): Promise<GitStatus> => gitStatus(folder),
  );

  ipcMain.handle(
    "editor:git-stage",
    (_event, folder: string, path: string) =>
      gitRun(folder, ["add", "--", path]),
  );

  ipcMain.handle("editor:git-stage-all", (_event, folder: string) =>
    gitRun(folder, ["add", "-A"]),
  );

  ipcMain.handle(
    "editor:git-unstage",
    (_event, folder: string, path: string) =>
      gitRun(folder, ["reset", "-q", "HEAD", "--", path]),
  );

  ipcMain.handle(
    "editor:git-discard",
    (_event, folder: string, path: string) =>
      gitRun(folder, ["checkout", "--", path]),
  );

  ipcMain.handle(
    "editor:git-commit",
    (_event, folder: string, message: string) =>
      gitRun(folder, ["commit", "-m", message]),
  );

  ipcMain.handle(
    "editor:find-files",
    (_event, folder: string, query: string): Promise<string[]> =>
      findFiles(folder, query),
  );
}
