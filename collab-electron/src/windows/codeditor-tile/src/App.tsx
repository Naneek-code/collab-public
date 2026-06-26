import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Files,
  GitBranch,
  Search,
  Settings,
  X,
} from "lucide-react";
import { FileTree } from "./FileTree";
import {
  DEFAULT_SETTINGS,
  GitPanel,
  SearchPanel,
  SettingsPanel,
  type EditorSettings,
} from "./panels";
import "./styles/App.css";

// Monaco is heavy; load the editor only when a file is first opened so the
// tile chrome (activity bar, explorer) paints instantly.
const TileEditor = lazy(() =>
  import("./TileEditor").then((m) => ({ default: m.TileEditor })),
);

const SETTINGS_PREF_KEY = "codeEditor.settings";

type View = "explorer" | "search" | "git" | "settings";

function useDarkTheme(): "light" | "dark" {
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setDark(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return dark ? "dark" : "light";
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function languageLabel(p: string): string {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript JSX",
    js: "JavaScript",
    jsx: "JavaScript JSX",
    json: "JSON",
    py: "Python",
    rs: "Rust",
    go: "Go",
    md: "Markdown",
    css: "CSS",
    html: "HTML",
    java: "Java",
    c: "C",
    cpp: "C++",
    cs: "C#",
    sh: "Shell",
    yml: "YAML",
    yaml: "YAML",
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : "Plain Text");
}

interface Tab {
  path: string;
  name: string;
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const folder = params.get("folder") || "";
  const theme = useDarkTheme();

  const [view, setView] = useState<View>("explorer");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState<EditorSettings>(DEFAULT_SETTINGS);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [branch, setBranch] = useState<string>("");
  const dragIndex = useRef<number | null>(null);

  // Persisted editor settings.
  useEffect(() => {
    window.api
      .getPref?.(SETTINGS_PREF_KEY)
      .then((stored) => {
        if (stored && typeof stored === "object") {
          setSettings({ ...DEFAULT_SETTINGS, ...(stored as EditorSettings) });
        }
      })
      .catch(() => {});
  }, []);

  // Current branch for the status bar.
  useEffect(() => {
    if (!folder) return;
    window.api
      .editorGitStatus(folder)
      .then((s) => setBranch(s.isRepo ? s.branch : ""))
      .catch(() => setBranch(""));
  }, [folder]);

  const updateSettings = useCallback((next: EditorSettings) => {
    setSettings(next);
    window.api.setPref?.(SETTINGS_PREF_KEY, next);
  }, []);

  const editorOptions = useMemo(
    () => ({
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap,
      minimap: { enabled: settings.minimap },
      tabSize: settings.tabSize,
    }),
    [settings],
  );

  const openFile = useCallback((path: string, name: string) => {
    setActive(path);
    setTabs((t) => (t.some((x) => x.path === path) ? t : [...t, { path, name }]));
  }, []);

  const closeTab = useCallback((path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs((t) => {
      const idx = t.findIndex((x) => x.path === path);
      const next = t.filter((x) => x.path !== path);
      setActive((cur) => {
        if (cur !== path) return cur;
        const fallback = next[idx] ?? next[idx - 1] ?? next[0];
        return fallback ? fallback.path : null;
      });
      return next;
    });
  }, []);

  const handleDirty = useCallback((path: string, isDirty: boolean) => {
    setDirty((d) => (d[path] === isDirty ? d : { ...d, [path]: isDirty }));
  }, []);

  const reorderTabs = (from: number, to: number) => {
    if (from === to) return;
    setTabs((t) => {
      const next = [...t];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return next;
    });
  };

  const activityButton = (id: View, Icon: typeof Files, label: string) => (
    <Icon
      size={22}
      className={`vsc-act${view === id ? " active" : ""}`}
      onClick={() => setView(id)}
      aria-label={label}
    />
  );

  return (
    <div className="vsc">
      <div className="vsc-body">
        <div className="vsc-activitybar">
          {activityButton("explorer", Files, "Explorer")}
          {activityButton("search", Search, "Search")}
          {activityButton("git", GitBranch, "Source Control")}
          <div className="vsc-act-spacer" />
          {activityButton("settings", Settings, "Settings")}
        </div>

        <div className="vsc-sidebar">
          {view === "explorer" && (
            <div className="vsc-panel">
              <div className="vsc-sidebar-title">Explorer</div>
              <div className="vsc-folder-name">
                {basename(folder) || "Folder"}
              </div>
              <div className="vsc-tree-scroll">
                {folder ? (
                  <FileTree root={folder} activePath={active} onOpen={openFile} />
                ) : (
                  <div className="vsc-tree-loading">No folder</div>
                )}
              </div>
            </div>
          )}
          {view === "search" && (
            <SearchPanel folder={folder} onOpen={openFile} />
          )}
          {view === "git" && <GitPanel folder={folder} onOpen={openFile} />}
          {view === "settings" && (
            <SettingsPanel settings={settings} onChange={updateSettings} />
          )}
        </div>

        <div className="vsc-main">
          <div className="vsc-tabs">
            {tabs.map((t, i) => (
              <div
                key={t.path}
                className={`vsc-tab${active === t.path ? " active" : ""}${
                  dirty[t.path] ? " dirty" : ""
                }`}
                onClick={() => setActive(t.path)}
                title={t.path}
                draggable
                onDragStart={() => {
                  dragIndex.current = i;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex.current !== null) {
                    reorderTabs(dragIndex.current, i);
                    dragIndex.current = null;
                  }
                }}
              >
                <span className="vsc-tab-name">{t.name}</span>
                <span className="vsc-tab-controls">
                  <X
                    size={13}
                    className="vsc-tab-close"
                    onClick={(e: React.MouseEvent) => closeTab(t.path, e)}
                  />
                  <span className="vsc-tab-dot" />
                </span>
              </div>
            ))}
          </div>

          <div className="vsc-editor">
            {active ? (
              <Suspense
                fallback={<div className="vsc-welcome">Loading editor…</div>}
              >
                <TileEditor
                  activePath={active}
                  theme={theme}
                  editorOptions={editorOptions}
                  onDirtyChange={handleDirty}
                  onCursorChange={(line, col) => setCursor({ line, col })}
                />
              </Suspense>
            ) : (
              <div className="vsc-welcome">
                <div className="vsc-welcome-title">VS Code</div>
                <div className="vsc-welcome-sub">
                  Select a file in the Explorer to start editing
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="vsc-statusbar">
        <span className="vsc-status-item">
          <GitBranch size={12} /> {branch || "—"}
        </span>
        <div className="vsc-status-spacer" />
        {active && (
          <>
            <span className="vsc-status-item">
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span className="vsc-status-item">
              Spaces: {settings.tabSize}
            </span>
            <span className="vsc-status-item">{languageLabel(active)}</span>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
