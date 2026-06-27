import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import './CodeDiffView.css';

// Define themes globally in this module too so they are guaranteed to exist
try {
  monaco.editor.defineTheme('monokai-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '75715E' },
      { token: 'string', foreground: 'E6DB74' },
      { token: 'keyword', foreground: 'F92672' },
      { token: 'number', foreground: 'AE81FF' },
      { token: 'constant', foreground: 'AE81FF' },
      { token: 'type', foreground: '66D9EF', fontStyle: 'italic' },
      { token: 'function', foreground: 'A6E22E' },
      { token: 'variable', foreground: 'F8F8F2' },
      {
        token: 'variable.predefined',
        foreground: 'FD971F',
        fontStyle: 'italic',
      },
      { token: 'tag', foreground: 'F92672' },
      { token: 'attribute.name', foreground: 'A6E22E' },
      { token: 'attribute.value', foreground: 'E6DB74' },
      { token: 'operator', foreground: 'F92672' },
    ],
    colors: {
      'editor.background': '#1F1F1F',
      'editor.foreground': '#DDDDDD',
      'editor.lineHighlightBackground': '#292929',
      'editor.selectionBackground': '#464646',
      'editorCursor.foreground': '#F2F2F2',
      'editorWhitespace.foreground': '#363636',
      'editorLineNumber.foreground': '#666666',
      'editorLineNumber.activeForeground': '#666666',
      'editorStickyScroll.shadow': '#00000000',
    },
  });

  monaco.editor.defineTheme('monokai-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '9F9F8F' },
      { token: 'string', foreground: 'F25A00' },
      { token: 'keyword', foreground: 'F92672' },
      { token: 'number', foreground: 'AE81FF' },
      { token: 'constant', foreground: 'AE81FF' },
      { token: 'type', foreground: '28C6E4', fontStyle: 'italic' },
      { token: 'function', foreground: '6AAF19' },
      { token: 'variable', foreground: '000000' },
      {
        token: 'variable.predefined',
        foreground: 'FD971F',
        fontStyle: 'italic',
      },
      { token: 'tag', foreground: 'F92672' },
      { token: 'attribute.name', foreground: '6AAF19' },
      { token: 'attribute.value', foreground: 'F25A00' },
      { token: 'operator', foreground: 'F92672' },
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#000000',
      'editor.lineHighlightBackground': '#A5A5A526',
      'editor.selectionBackground': '#C2E8FF',
      'editorCursor.foreground': '#000000',
      'editorWhitespace.foreground': '#E0E0E0',
      'editorLineNumber.foreground': '#9F9F8F',
      'editorLineNumber.activeForeground': '#000000',
      'editorStickyScroll.shadow': '#00000000',
    },
  });
} catch {
  // Ignore if already defined
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    jsonc: 'json',
    py: 'python',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    graphql: 'graphql',
    md: 'markdown',
    markdown: 'markdown',
  };
  return map[ext] ?? 'plaintext';
}

interface CodeDiffViewProps {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  theme: 'light' | 'dark';
  className?: string;
}

export function CodeDiffView({
  filePath,
  originalContent,
  modifiedContent,
  theme,
  className,
}: CodeDiffViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(
    null
  );
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const language = getLanguageFromPath(filePath);

    const originalModel = monaco.editor.createModel(
      originalContent,
      language,
      monaco.Uri.parse(`git-diff://original/${filePath}`)
    );
    const modifiedModel = monaco.editor.createModel(
      modifiedContent,
      language,
      monaco.Uri.parse(`git-diff://modified/${filePath}`)
    );

    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: theme === 'dark' ? 'monokai-dark' : 'monokai-light',
      minimap: { enabled: false },
      wordWrap: 'on',
      fontSize: 12,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      scrollbar: {
        verticalScrollbarSize: 7,
        horizontalScrollbarSize: 7,
      },
      automaticLayout: true,
      readOnly: true,
      padding: { top: 8 },
    });

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    diffEditorRef.current = diffEditor;
    originalModelRef.current = originalModel;
    modifiedModelRef.current = modifiedModel;

    monaco.editor.setTheme(theme === 'dark' ? 'monokai-dark' : 'monokai-light');

    return () => {
      diffEditor.setModel(null);
      originalModel.dispose();
      modifiedModel.dispose();
      diffEditor.dispose();
      diffEditorRef.current = null;
      originalModelRef.current = null;
      modifiedModelRef.current = null;
    };
  }, [filePath, originalContent, modifiedContent, theme]);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'monokai-dark' : 'monokai-light');
  }, [theme]);

  return (
    <div
      ref={containerRef}
      className={`code-diff-view-container ${className ?? ''}`}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
