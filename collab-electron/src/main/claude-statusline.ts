import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFileSync } from "./files";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
export const PROBE_STATE_DIR = join(CLAUDE_DIR, "collab-prompt");

const PROBE_DIR = join(homedir(), ".collaborator", "collab-prompt");
const PROBE_MJS = join(PROBE_DIR, "collab-prompt-probe.mjs");
const WRAPPED_FILE = join(PROBE_DIR, "wrapped.txt");

// Claude Code runs the statusLine command through bash, where a backslash
// Windows path can't be executed — so use a bash launcher (like other HUD
// statuslines) that resolves the app's node binary, converts the path on
// Windows via cygpath, and runs the probe as plain Node. Works on every
// platform/shell; `cygpath` is simply skipped where absent.
const LAUNCHER_MARKER = "collab-prompt-probe.mjs";
const LAUNCHER = `bash -c 'NB="$(cat "$HOME/.collaborator/node-path" 2>/dev/null)"; command -v cygpath >/dev/null && NB="$(cygpath -u "$NB")"; [ -x "$NB" ] || exit 0; ELECTRON_RUN_AS_NODE=1 exec "$NB" "$HOME/.collaborator/collab-prompt/collab-prompt-probe.mjs"'`;

// Probe script source, base64-encoded. It contains ESM `import` statements and
// is written verbatim to disk — keeping it encoded stops the bundler's
// CommonJS-shim injector from rewriting those tokens (which would corrupt both
// this string and the surrounding module's `__dirname` shim). Decode at write.
//
// Decoded script: reads Claude Code's native statusline JSON on stdin, writes
// it to ~/.claude/collab-prompt/<session_id>.json, then forwards stdin to any
// pre-existing statusline command (chaining) so an installed HUD keeps working.
// On Windows a `bash -c '…'` chained command is forwarded through bash, since
// cmd.exe/PowerShell mangle its nested quoting.
const PROBE_SOURCE_B64 =
  "aW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsgam9pbiB9IGZyb20gIm5vZGU6cGF0aCI7CmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICJub2RlOm9zIjsKaW1wb3J0IHsgc3Bhd24gfSBmcm9tICJub2RlOmNoaWxkX3Byb2Nlc3MiOwoKbGV0IGlucHV0ID0gIiI7CnByb2Nlc3Muc3RkaW4uc2V0RW5jb2RpbmcoInV0ZjgiKTsKcHJvY2Vzcy5zdGRpbi5vbigiZGF0YSIsIChkKSA9PiB7IGlucHV0ICs9IGQ7IH0pOwpwcm9jZXNzLnN0ZGluLm9uKCJlcnJvciIsICgpID0+IHByb2Nlc3MuZXhpdCgwKSk7CnByb2Nlc3Muc3RkaW4ub24oImVuZCIsICgpID0+IHsKICB0cnkgewogICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UoaW5wdXQpOwogICAgY29uc3QgaWQgPSBkYXRhICYmIGRhdGEuc2Vzc2lvbl9pZDsKICAgIGlmIChpZCAmJiAvXltcdy4tXSskLy50ZXN0KGlkKSkgewogICAgICBjb25zdCBkaXIgPSBqb2luKGhvbWVkaXIoKSwgIi5jbGF1ZGUiLCAiY29sbGFiLXByb21wdCIpOwogICAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTsKICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgaWQgKyAiLmpzb24iKSwgaW5wdXQpOwogICAgfQogIH0gY2F0Y2gge30KICBsZXQgd3JhcHBlZCA9ICIiOwogIHRyeSB7CiAgICB3cmFwcGVkID0gcmVhZEZpbGVTeW5jKAogICAgICBqb2luKGhvbWVkaXIoKSwgIi5jb2xsYWJvcmF0b3IiLCAiY29sbGFiLXByb21wdCIsICJ3cmFwcGVkLnR4dCIpLAogICAgICAidXRmOCIsCiAgICApLnRyaW0oKTsKICB9IGNhdGNoIHt9CiAgaWYgKCF3cmFwcGVkKSB7IHByb2Nlc3MuZXhpdCgwKTsgfQogIHRyeSB7CiAgICBjb25zdCBlbnYgPSB7IC4uLnByb2Nlc3MuZW52IH07CiAgICBkZWxldGUgZW52LkVMRUNUUk9OX1JVTl9BU19OT0RFOwogICAgY29uc3QgdXNlQmFzaCA9CiAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09ICJ3aW4zMiIgJiYgLyhefFxzKWJhc2hccystY1xiLy50ZXN0KHdyYXBwZWQpOwogICAgY29uc3QgY2hpbGQgPSBzcGF3bih3cmFwcGVkLCB7IHNoZWxsOiB1c2VCYXNoID8gImJhc2guZXhlIiA6IHRydWUsIGVudiB9KTsKICAgIGNoaWxkLnN0ZG91dC5vbigiZGF0YSIsIChkKSA9PiBwcm9jZXNzLnN0ZG91dC53cml0ZShkKSk7CiAgICBjaGlsZC5vbigiZXJyb3IiLCAoKSA9PiBwcm9jZXNzLmV4aXQoMCkpOwogICAgY2hpbGQub24oImNsb3NlIiwgKGNvZGUpID0+IHByb2Nlc3MuZXhpdChjb2RlID09IG51bGwgPyAwIDogY29kZSkpOwogICAgY2hpbGQuc3RkaW4ub24oImVycm9yIiwgKCkgPT4ge30pOwogICAgY2hpbGQuc3RkaW4ud3JpdGUoaW5wdXQpOwogICAgY2hpbGQuc3RkaW4uZW5kKCk7CiAgfSBjYXRjaCB7CiAgICBwcm9jZXNzLmV4aXQoMCk7CiAgfQp9KTsK";
const PROBE_SOURCE = Buffer.from(PROBE_SOURCE_B64, "base64").toString("utf8");

interface StatusLineEntry {
  type?: string;
  command?: string;
}

function readSettings(): Record<string, unknown> | null {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isOurs(entry: StatusLineEntry | undefined): boolean {
  return entry?.command?.includes(LAUNCHER_MARKER) ?? false;
}

function writeScripts(): void {
  mkdirSync(PROBE_DIR, { recursive: true });
  mkdirSync(PROBE_STATE_DIR, { recursive: true });
  writeFileSync(PROBE_MJS, PROBE_SOURCE, "utf8");
}

export function enableProbe(): { ok: boolean; error?: string } {
  if (!existsSync(CLAUDE_DIR)) {
    return { ok: true };
  }

  const settings = readSettings();
  if (settings === null) {
    return { ok: false, error: "Could not parse ~/.claude/settings.json" };
  }

  writeScripts();

  const current = settings.statusLine as StatusLineEntry | undefined;
  // Snapshot a foreign statusline so the probe can chain to it. Never snapshot
  // our own launcher (would recurse).
  if (current?.command && !isOurs(current)) {
    writeFileSync(WRAPPED_FILE, current.command, "utf8");
  } else if (!existsSync(WRAPPED_FILE)) {
    writeFileSync(WRAPPED_FILE, "", "utf8");
  }

  settings.statusLine = { type: "command", command: LAUNCHER };
  try {
    atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  return { ok: true };
}

export function disableProbe(): { ok: boolean; error?: string } {
  const settings = readSettings();
  if (settings === null) return { ok: false, error: "Could not parse settings" };

  const current = settings.statusLine as StatusLineEntry | undefined;
  if (isOurs(current)) {
    let wrapped = "";
    try {
      wrapped = readFileSync(WRAPPED_FILE, "utf8").trim();
    } catch {}
    if (wrapped) {
      settings.statusLine = { type: "command", command: wrapped };
    } else {
      delete settings.statusLine;
    }
    try {
      atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  try {
    rmSync(WRAPPED_FILE, { force: true });
  } catch {}
  return { ok: true };
}

// Re-assert install on launch: script paths are absolute and survive app
// updates, but rewriting keeps them current and re-chains if a HUD appeared.
export function refreshProbe(enabled: boolean): void {
  if (enabled) enableProbe();
}
