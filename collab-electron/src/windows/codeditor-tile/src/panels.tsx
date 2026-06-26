import { useCallback, useEffect, useRef, useState } from "react";

const SEP = (root: string) => (root.includes("\\") ? "\\" : "/");

function joinPath(parent: string, rel: string): string {
  const sep = SEP(parent);
  const norm = rel.replace(/[\\/]/g, sep);
  return parent.endsWith(sep) ? parent + norm : parent + sep + norm;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/* ── Search ─────────────────────────────────────────────────────────── */

export function SearchPanel({
  folder,
  onOpen,
}: {
  folder: string;
  onOpen: (path: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(() => {
      window.api
        .editorFindFiles(folder, query)
        .then((r) => setResults(r))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, folder]);

  return (
    <div className="vsc-panel">
      <div className="vsc-sidebar-title">Search</div>
      <input
        className="vsc-search-input"
        placeholder="Search files by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="vsc-tree-scroll">
        {searching && <div className="vsc-tree-loading">Searching…</div>}
        {!searching && query && results.length === 0 && (
          <div className="vsc-tree-loading">No results</div>
        )}
        {results.map((p) => (
          <div
            key={p}
            className="vsc-row"
            style={{ paddingLeft: 10 }}
            onClick={() => onOpen(p, basename(p))}
            title={p}
          >
            <span className="vsc-row-label">{basename(p)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Source control (git) ───────────────────────────────────────────── */

interface GitFile {
  path: string;
  index: string;
  worktree: string;
}

interface GitStatusData {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  error?: string;
}

function letterFor(ch: string): { letter: string; cls: string } {
  switch (ch) {
    case "M":
      return { letter: "M", cls: "git-m" };
    case "A":
      return { letter: "A", cls: "git-a" };
    case "D":
      return { letter: "D", cls: "git-d" };
    case "R":
      return { letter: "R", cls: "git-m" };
    case "?":
      return { letter: "U", cls: "git-u" };
    default:
      return { letter: ch.trim() || "•", cls: "git-m" };
  }
}

function GitRow({
  folder,
  file,
  staged,
  onOpen,
  onChanged,
}: {
  folder: string;
  file: GitFile;
  staged: boolean;
  onOpen: (path: string, name: string) => void;
  onChanged: () => void;
}) {
  const ch = staged ? file.index : file.worktree;
  const { letter, cls } = letterFor(ch);
  const full = joinPath(folder, file.path);

  const act = async (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    await fn();
    onChanged();
  };

  return (
    <div
      className="vsc-row vsc-git-row"
      style={{ paddingLeft: 18 }}
      onClick={() => onOpen(full, basename(file.path))}
      title={file.path}
    >
      <span className="vsc-row-label">{basename(file.path)}</span>
      <span className="vsc-git-dir">{file.path}</span>
      <span className="vsc-git-actions">
        {staged ? (
          <button
            className="vsc-mini-btn"
            title="Unstage"
            onClick={(e) =>
              act(() => window.api.editorGitUnstage(folder, file.path), e)
            }
          >
            −
          </button>
        ) : (
          <>
            <button
              className="vsc-mini-btn"
              title="Discard changes"
              onClick={(e) => {
                if (
                  !window.confirm(`Discard changes in ${basename(file.path)}?`)
                )
                  return;
                void act(
                  () => window.api.editorGitDiscard(folder, file.path),
                  e,
                );
              }}
            >
              ↩
            </button>
            <button
              className="vsc-mini-btn"
              title="Stage"
              onClick={(e) =>
                act(() => window.api.editorGitStage(folder, file.path), e)
              }
            >
              +
            </button>
          </>
        )}
      </span>
      <span className={`vsc-git-status ${cls}`}>{letter}</span>
    </div>
  );
}

export function GitPanel({
  folder,
  onOpen,
}: {
  folder: string;
  onOpen: (path: string, name: string) => void;
}) {
  const [data, setData] = useState<GitStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    window.api
      .editorGitStatus(folder)
      .then((d) => setData(d as GitStatusData))
      .catch(() =>
        setData({
          isRepo: false,
          branch: "",
          ahead: 0,
          behind: 0,
          files: [],
        }),
      )
      .finally(() => setLoading(false));
  }, [folder]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const staged = (data?.files ?? []).filter(
    (f) => f.index !== " " && f.index !== "?",
  );
  const changes = (data?.files ?? []).filter((f) => f.worktree !== " ");

  const commit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    if (staged.length === 0) await window.api.editorGitStageAll(folder);
    const res = await window.api.editorGitCommit(folder, message);
    setBusy(false);
    if (res.ok) {
      setMessage("");
      refresh();
    } else {
      setError(res.error ?? "Commit failed");
    }
  };

  return (
    <div className="vsc-panel">
      <div className="vsc-sidebar-title vsc-title-row">
        <span>Source Control</span>
        <button className="vsc-mini-btn" onClick={refresh} title="Refresh">
          ⟳
        </button>
      </div>

      {data?.isRepo && (
        <>
          <div className="vsc-git-branch">
            ⎇ {data.branch || "—"}
            {data.ahead > 0 && <span className="vsc-git-sync"> ↑{data.ahead}</span>}
            {data.behind > 0 && (
              <span className="vsc-git-sync"> ↓{data.behind}</span>
            )}
          </div>
          <div className="vsc-commit-box">
            <textarea
              className="vsc-commit-input"
              placeholder="Message (Ctrl+Enter to commit)"
              value={message}
              rows={2}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void commit();
                }
              }}
            />
            <button
              className="vsc-commit-btn"
              disabled={busy || !message.trim() || changes.length === 0}
              onClick={() => void commit()}
              title="Commit (stages all if nothing is staged)"
            >
              ✓ Commit
            </button>
            {error && <div className="vsc-commit-error">{error}</div>}
          </div>
        </>
      )}

      <div className="vsc-tree-scroll">
        {loading && <div className="vsc-tree-loading">Loading…</div>}
        {!loading && data && !data.isRepo && (
          <div className="vsc-tree-loading">Not a git repository.</div>
        )}
        {!loading && data?.isRepo && changes.length === 0 && staged.length === 0 && (
          <div className="vsc-tree-loading">No changes</div>
        )}

        {staged.length > 0 && (
          <div className="vsc-git-group">
            Staged Changes
            <span className="vsc-git-count">{staged.length}</span>
          </div>
        )}
        {staged.map((f) => (
          <GitRow
            key={`s-${f.path}`}
            folder={folder}
            file={f}
            staged
            onOpen={onOpen}
            onChanged={refresh}
          />
        ))}

        {changes.length > 0 && (
          <div className="vsc-git-group">
            Changes
            <span className="vsc-git-count">{changes.length}</span>
            <button
              className="vsc-mini-btn vsc-git-group-btn"
              title="Stage all changes"
              onClick={() =>
                void window.api.editorGitStageAll(folder).then(refresh)
              }
            >
              +
            </button>
          </div>
        )}
        {changes.map((f) => (
          <GitRow
            key={`c-${f.path}`}
            folder={folder}
            file={f}
            staged={false}
            onOpen={onOpen}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Settings ───────────────────────────────────────────────────────── */

export interface EditorSettings {
  fontSize: number;
  wordWrap: "on" | "off";
  minimap: boolean;
  tabSize: number;
}

export const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 12,
  wordWrap: "on",
  minimap: false,
  tabSize: 2,
};

export function SettingsPanel({
  settings,
  onChange,
}: {
  settings: EditorSettings;
  onChange: (next: EditorSettings) => void;
}) {
  const set = <K extends keyof EditorSettings>(
    key: K,
    value: EditorSettings[K],
  ) => onChange({ ...settings, [key]: value });

  return (
    <div className="vsc-panel">
      <div className="vsc-sidebar-title">Settings</div>
      <div className="vsc-settings">
        <label className="vsc-setting">
          <span>Font size</span>
          <input
            type="number"
            min={8}
            max={32}
            value={settings.fontSize}
            onChange={(e) =>
              set("fontSize", Number(e.target.value) || 12)
            }
          />
        </label>
        <label className="vsc-setting">
          <span>Tab size</span>
          <input
            type="number"
            min={1}
            max={8}
            value={settings.tabSize}
            onChange={(e) => set("tabSize", Number(e.target.value) || 2)}
          />
        </label>
        <label className="vsc-setting vsc-setting-row">
          <span>Word wrap</span>
          <input
            type="checkbox"
            checked={settings.wordWrap === "on"}
            onChange={(e) => set("wordWrap", e.target.checked ? "on" : "off")}
          />
        </label>
        <label className="vsc-setting vsc-setting-row">
          <span>Minimap</span>
          <input
            type="checkbox"
            checked={settings.minimap}
            onChange={(e) => set("minimap", e.target.checked)}
          />
        </label>
      </div>
    </div>
  );
}
