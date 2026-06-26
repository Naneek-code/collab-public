import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new htmlWorker();
    if (label === "typescript" || label === "javascript")
      return new tsWorker();
    return new editorWorker();
  },
};

function languageFromPath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "json",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    xml: "xml",
    svg: "xml",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    md: "markdown",
    markdown: "markdown",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    lua: "lua",
    r: "r",
    dockerfile: "dockerfile",
  };
  return map[ext] ?? "plaintext";
}

interface TileEditorProps {
  activePath: string | null;
  theme: "light" | "dark";
  editorOptions?: monaco.editor.IEditorOptions;
  /** Called whenever a file's unsaved state changes. */
  onDirtyChange: (path: string, dirty: boolean) => void;
  /** Called on cursor move for the status bar. */
  onCursorChange?: (line: number, column: number) => void;
}

export function TileEditor({
  activePath,
  theme,
  editorOptions,
  onDirtyChange,
  onCursorChange,
}: TileEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Per-file model registry so each tab keeps its own undo stack + edits.
  const modelsByPath = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const pathByUri = useRef<Map<string, string>>(new Map());
  // Alternative version id captured at last save — used to compute dirty.
  const savedVersions = useRef<Map<string, number>>(new Map());
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  const onCursorRef = useRef(onCursorChange);
  onCursorRef.current = onCursorChange;

  const reportDirty = (model: monaco.editor.ITextModel) => {
    const uri = model.uri.toString();
    const path = pathByUri.current.get(uri);
    if (!path) return;
    const dirty = savedVersions.current.get(uri) !== model.getAlternativeVersionId();
    onDirtyRef.current(path, dirty);
  };

  const saveActive = async () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const uri = model.uri.toString();
    const path = pathByUri.current.get(uri);
    if (!path) return;
    try {
      await window.api.writeFile(path, model.getValue());
      savedVersions.current.set(uri, model.getAlternativeVersionId());
      reportDirty(model);
    } catch {
      // Leave the file dirty if the write failed.
    }
  };
  const saveActiveRef = useRef(saveActive);
  saveActiveRef.current = saveActive;

  // Create the editor once.
  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      theme: theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      wordWrap: "on",
      tabSize: 2,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
      padding: { top: 8 },
      ...editorOptions,
    });
    editorRef.current = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveActiveRef.current();
    });

    const sub = editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (model) reportDirty(model);
    });

    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      onCursorRef.current?.(e.position.lineNumber, e.position.column);
    });

    return () => {
      sub.dispose();
      cursorSub.dispose();
      editor.dispose();
      editorRef.current = null;
      for (const model of modelsByPath.current.values()) model.dispose();
      modelsByPath.current.clear();
      pathByUri.current.clear();
      savedVersions.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap to the active file's model (loading it from disk on first open).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!activePath) {
      editor.setModel(null);
      return;
    }

    let cancelled = false;
    const mount = (model: monaco.editor.ITextModel) => {
      if (cancelled) return;
      editor.setModel(model);
      editor.focus();
      reportDirty(model);
    };

    const existing = modelsByPath.current.get(activePath);
    if (existing) {
      mount(existing);
      return;
    }

    window.api
      .readFile(activePath)
      .then((content: string) => {
        if (cancelled) return;
        const uri = monaco.Uri.file(activePath);
        const model =
          monaco.editor.getModel(uri) ??
          monaco.editor.createModel(content, languageFromPath(activePath), uri);
        modelsByPath.current.set(activePath, model);
        pathByUri.current.set(uri.toString(), activePath);
        if (!savedVersions.current.has(uri.toString())) {
          savedVersions.current.set(uri.toString(), model.getAlternativeVersionId());
        }
        mount(model);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // Live theme + option updates.
  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }, [theme]);

  useEffect(() => {
    if (editorOptions) editorRef.current?.updateOptions(editorOptions);
  }, [editorOptions]);

  return <div className="vsc-editor-host" ref={containerRef} />;
}
