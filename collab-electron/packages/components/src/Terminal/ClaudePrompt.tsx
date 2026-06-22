import * as React from "react";
import * as ReactDOM from "react-dom";
import type { Terminal } from "@xterm/xterm";
import { Sparkles, ZoomIn, ZoomOut, RotateCcw, X, ChevronDown } from "lucide-react";
import { ClaudeLogo } from "./ClaudeLogo";
import { CLAUDE_MODELS, CLAUDE_SLASH_COMMANDS } from "./claude-prompt-commands";
import {
  createTempImageFromBlob,
  extractAllClipboardData,
} from "./clipboard-util";
import {
  ClaudePromptSuggest,
  type ClaudeSuggestHandle,
  type PromptSuggestion,
} from "./ClaudePromptSuggest";
import "./ClaudePrompt.css";

interface ClaudePromptProps {
  sessionId: string;
  term: Terminal;
}

type ContentPart =
  | { type: "text"; content: string }
  | { type: "image"; path: string };
type SuggestTrigger =
  | { kind: "slash"; query: string }
  | { kind: "model"; query: string }
  | null;
type DraftState = { text: string; images: string[] };

type ParsedStatus = {
  model?: string;
  contextInfo?: string;
  progress?: number;
  mode?: string;
  focused?: boolean;
};

const EMPTY_DRAFT: DraftState = { text: "", images: [] };
const BPM_START = "\x1b[200~";
const BPM_END = "\x1b[201~";
const HISTORY_KEY = "claude:prompthistory";

const MODEL_QUICK_SWITCHES = [
  { id: "sonnet", title: "Sonnet" },
  { id: "claude-opus-4-6", title: "Opus 4.6" },
  { id: "claude-opus-4-7", title: "Opus 4.7" },
  { id: "claude-opus-4-8", title: "Opus 4.8" },
  { id: "claude-opus-4-6[1m]", title: "Opus 4.6 · 1M" },
  { id: "claude-opus-4-7[1m]", title: "Opus 4.7 · 1M" },
  { id: "claude-opus-4-8[1m]", title: "Opus 4.8 · 1M" },
] as const;

function matchQuickSwitchId(rawModel: string | undefined): string {
  if (!rawModel) return "";
  const m = rawModel.toLowerCase();
  return (
    MODEL_QUICK_SWITCHES.find((s) =>
      s.id === "sonnet" ? m.includes("sonnet") : m === s.id,
    )?.id ?? ""
  );
}

function draftKey(sessionId: string): string {
  return `claude:draft:${sessionId}`;
}

function loadHistory(): ContentPart[][] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((e) => Array.isArray(e)) : [];
  } catch {
    return [];
  }
}

function cloneDraft(draft: DraftState): DraftState {
  return { text: draft.text, images: [...draft.images] };
}

function isDraftEmpty(draft: DraftState): boolean {
  return draft.text.trim().length === 0 && draft.images.length === 0;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getDraftHistoryKey(draft: DraftState): string {
  return draft.text.trim();
}

function draftToParts(draft: DraftState): ContentPart[] {
  const parts: ContentPart[] = [];
  if (draft.text.length > 0) parts.push({ type: "text", content: draft.text });
  for (const path of draft.images) parts.push({ type: "image", path });
  return parts;
}

function partsToDraft(parts: ContentPart[]): DraftState {
  let text = "";
  const images: string[] = [];
  for (const part of parts) {
    if (part.type === "text") text += part.content;
    else images.push(part.path);
  }
  return { text, images };
}

// The draft text carries `[Image #N]` placeholders wherever an image was pasted;
// these map 1:1 (1-indexed) to draft.images. Split on the placeholders and
// interleave the image paths so the send order matches what the user sees.
const IMAGE_PLACEHOLDER_RE = /\[Image #(\d+)\]/g;

function draftToSendParts(draft: DraftState): ContentPart[] {
  const parts: ContentPart[] = [];
  const text = draft.text;
  const used = new Set<number>();
  let lastIdx = 0;
  IMAGE_PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_PLACEHOLDER_RE.exec(text)) !== null) {
    const before = text.slice(lastIdx, match.index);
    if (before.length > 0) parts.push({ type: "text", content: before });
    const imgIdx = parseInt(match[1] ?? "", 10) - 1;
    const img = draft.images[imgIdx];
    if (imgIdx >= 0 && img !== undefined) {
      parts.push({ type: "image", path: img });
      used.add(imgIdx);
    }
    lastIdx = match.index + match[0].length;
  }
  const after = text.slice(lastIdx);
  if (after.length > 0) parts.push({ type: "text", content: after });
  for (let i = 0; i < draft.images.length; i++) {
    const img = draft.images[i];
    if (!used.has(i) && img !== undefined) {
      parts.push({ type: "image", path: img });
    }
  }
  return parts;
}

function consolidateParts(parts: ContentPart[]): ContentPart[] {
  const consolidated: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const last = consolidated[consolidated.length - 1];
      if (last?.type === "text") last.content += part.content;
      else consolidated.push({ type: "text", content: part.content });
    } else {
      consolidated.push(part);
    }
  }
  return consolidated;
}

function modeKey(mode: string): string {
  const m = mode.toLowerCase();
  if (m.includes("plan")) return "plan";
  if (m.includes("accept")) return "accept";
  if (m.includes("bypass")) return "bypass";
  if (m.includes("auto")) return "auto";
  return "default";
}

const PERMISSION_MODE_LABELS: Record<string, string> = {
  auto: "auto",
  default: "normal",
  normal: "normal",
  plan: "plan",
  acceptedits: "accept edits",
  bypasspermissions: "bypass permissions",
};

function prettyMode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase().replace(/[\s_-]/g, "");
  return PERMISSION_MODE_LABELS[key] ?? raw.toLowerCase().replace(/\s+/g, " ");
}

// Turns a raw model id (`claude-opus-4-8`, `claude-haiku-4-5-20251001`,
// `claude-opus-4-8[1m]`) into a display name + optional context label.
function prettyModel(raw: string | undefined): {
  model?: string;
  contextInfo?: string;
} {
  if (!raw) return {};
  let contextInfo: string | undefined;
  const beta = raw.match(/\[([^\]]+)\]/);
  if (beta?.[1]) {
    const b = beta[1].toLowerCase();
    if (b.includes("1m")) contextInfo = "1M context";
  }
  const label = raw
    .replace(/\[[^\]]*\]/, "")
    .replace(/-\d{6,8}$/, "")
    .split("-")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("-");
  const out: { model?: string; contextInfo?: string } = {};
  if (label) out.model = label;
  if (contextInfo) out.contextInfo = contextInfo;
  return out;
}

function parseStatusLines(lines: string[]): ParsedStatus {
  if (lines.length === 0) return {};
  const combined = lines.join(" ").replace(/\s+/g, " ");
  const firstLine = lines[0] ?? "";
  const result: ParsedStatus = {};

  const modelMatch = firstLine.match(/^\s*\[([^\]]+?)(?:\s*\(([^)]+)\))?\]/);
  if (modelMatch?.[1]) {
    result.model = modelMatch[1].trim();
    if (modelMatch[2]) result.contextInfo = modelMatch[2].trim();
  }

  const progressMatch = firstLine.match(/\][^%]*?(\d{1,3})\s*%/);
  if (progressMatch?.[1]) result.progress = parseInt(progressMatch[1], 10);

  const modeMatch = combined.match(/([\w\s]+?)\s+on\s+\(\S+\s+to\s+cycle\)/i);
  if (modeMatch?.[1]) {
    result.mode = modeMatch[1].trim().toLowerCase().replace(/\s+/g, " ");
  }

  if (/\bfocus\b/i.test(combined)) result.focused = true;

  return result;
}

function makeImageChip(num: number, path: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.className = "claude-prompt-image-chip";
  span.dataset.imgpath = path;
  span.dataset.imgnum = String(num);
  span.setAttribute("title", path);

  const label = document.createElement("span");
  label.className = "claude-prompt-image-chip-label";
  label.textContent = `Image #${num}`;
  span.appendChild(label);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "claude-prompt-image-chip-remove";
  remove.setAttribute("aria-label", "Remove image");
  remove.tabIndex = -1;
  remove.textContent = "×";
  span.appendChild(remove);

  return span;
}

// Walks the editor DOM and rebuilds the DraftState. Image chip spans become
// `[Image #N]` placeholders in the text and contribute a path to the images
// array. Text nodes and <br> preserve the user's linebreaks.
function serializeEditor(el: HTMLElement): DraftState {
  const images: string[] = [];
  let text = "";
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.imgpath) {
      images.push(node.dataset.imgpath);
      text += `[Image #${images.length}]`;
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    const isBlock = node.tagName === "DIV" || node.tagName === "P";
    if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
    for (const child of Array.from(node.childNodes)) walk(child);
  }
  for (const child of Array.from(el.childNodes)) walk(child);
  return { text, images };
}

function renderEditor(el: HTMLElement, draft: DraftState): void {
  el.textContent = "";
  const appendText = (chunk: string) => {
    const lines = chunk.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) el.appendChild(document.createElement("br"));
      const ln = lines[i];
      if (ln) el.appendChild(document.createTextNode(ln));
    }
  };
  const text = draft.text;
  const re = /\[Image #(\d+)\]/g;
  let lastIdx = 0;
  let imgCount = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIdx, match.index);
    if (before.length > 0) appendText(before);
    const imgIdx = parseInt(match[1] ?? "", 10) - 1;
    const img = draft.images[imgIdx];
    if (imgIdx >= 0 && img !== undefined) {
      imgCount++;
      el.appendChild(makeImageChip(imgCount, img));
    } else {
      appendText(match[0]);
    }
    lastIdx = match.index + match[0].length;
  }
  const after = text.slice(lastIdx);
  if (after.length > 0) appendText(after);
}

function getCaretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.setStart(el, 0);
  try {
    pre.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  const tmp = document.createElement("div");
  tmp.appendChild(pre.cloneContents());
  return serializeEditor(tmp).text.length;
}

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// Scans Claude's recent output rows for the "Press Ctrl-C again to exit" banner.
// If it's showing, sending another Ctrl+C would kill Claude Code.
function detectExitBanner(terminal: Terminal): boolean {
  const buf = terminal?.buffer?.active;
  if (!buf) return false;
  const bufLen = buf.length;
  for (let i = bufLen - 1; i >= Math.max(0, bufLen - 15); i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    if (/press ctrl-?c again/i.test(line.translateToString(true))) return true;
  }
  return false;
}

function insertPartsAtCaret(
  el: HTMLElement,
  text: string,
  imagePaths: string[],
  startImageNum: number,
): void {
  const sel = window.getSelection();
  let range: Range;
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.deleteContents();

  const frag = document.createDocumentFragment();
  if (text.length > 0) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) frag.appendChild(document.createElement("br"));
      const ln = lines[i];
      if (ln) frag.appendChild(document.createTextNode(ln));
    }
  }
  for (let i = 0; i < imagePaths.length; i++) {
    const p = imagePaths[i];
    if (p !== undefined) frag.appendChild(makeImageChip(startImageNum + i, p));
  }

  const lastNode = frag.lastChild;
  range.insertNode(frag);

  const after = document.createRange();
  if (lastNode) after.setStartAfter(lastNode);
  else after.setStart(range.endContainer, range.endOffset);
  after.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(after);
}

function detectSuggestTrigger(
  text: string,
  caretOffset: number,
): SuggestTrigger {
  const textBeforeCaret = text.slice(0, caretOffset);

  const modelMatch = textBeforeCaret.match(/^\/model\s+(\S*)$/);
  if (modelMatch) return { kind: "model", query: modelMatch[1] ?? "" };

  if (/^\/\S*$/.test(textBeforeCaret)) {
    return { kind: "slash", query: textBeforeCaret.slice(1) };
  }

  return null;
}

function getCaretRect(el: HTMLElement): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0]) return rects[0];
  const collapsed = document.createRange();
  collapsed.setStart(range.startContainer, range.startOffset);
  collapsed.collapse(true);
  const tmp = document.createElement("span");
  tmp.appendChild(document.createTextNode("​"));
  collapsed.insertNode(tmp);
  const rect = tmp.getBoundingClientRect();
  tmp.remove();
  return rect;
}

function isCaretOnFirstLine(el: HTMLElement): boolean {
  const caretRect = getCaretRect(el);
  if (!caretRect) return true;
  const editorRect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 18;
  return caretRect.top - (editorRect.top + paddingTop) < lineHeight * 0.7;
}

function isCaretOnLastLine(el: HTMLElement): boolean {
  const caretRect = getCaretRect(el);
  if (!caretRect) return true;
  const editorRect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 18;
  return editorRect.bottom - paddingBottom - caretRect.bottom < lineHeight * 0.7;
}

// True when the terminal's current screen shows Claude Code's persistent UI.
// Keyed off long-lived markers (input box, status chip, mode banners) rather
// than the one-time startup banner, so detection survives a session reconnect
// and works on any shell. `text` is the last ~25 visible rows.
function looksLikeClaude(text: string): boolean {
  if (/[╭╮╰╯]/.test(text)) return true;
  if (
    /\besc to interrupt\b|\?\s*for shortcuts|auto-?accept edits|auto mode on|⏵⏵|bypass permissions|plan mode on|for agents\b|to cycle\)/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\[[^\]\n]*\b(opus|sonnet|haiku)\b[^\]\n]*\]/i.test(text)) return true;
  if (/press ctrl-?c again/i.test(text)) return true;
  return false;
}

const ClaudePrompt = React.memo(({ sessionId, term }: ClaudePromptProps) => {
  const [history, setHistory] = React.useState<ContentPart[][]>(() =>
    loadHistory(),
  );

  const [claudeCodeActive, setClaudeCodeActive] = React.useState(false);
  const [draft, setDraft] = React.useState<DraftState>(EMPTY_DRAFT);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [suggestState, setSuggestState] = React.useState<SuggestTrigger>(null);
  const [previewImgPath, setPreviewImgPath] = React.useState<string | null>(
    null,
  );
  const [statusLines, setStatusLines] = React.useState<string[]>([]);
  const [isQuestionMode, setIsQuestionMode] = React.useState(false);
  const [manualHide, setManualHide] = React.useState(false);
  const [isPasting, setIsPasting] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [structuredState, setStructuredState] = React.useState<{
    model?: string;
    mode?: string;
    permissionMode?: string;
    status?: string;
    contextTokens?: number;
    defaultModel?: string;
    contextWindowSize?: number;
    usedPercentage?: number;
  } | null>(null);
  const [terminalModel, setTerminalModel] = React.useState<{
    model: string;
    contextInfo?: string;
  } | null>(null);

  const editorRef = React.useRef<HTMLDivElement>(null);
  const modelMenuRef = React.useRef<HTMLDivElement>(null);
  const historyIndexRef = React.useRef<number | null>(null);
  const historyDraftRef = React.useRef<DraftState>(cloneDraft(EMPTY_DRAFT));
  const errorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const suggestRef = React.useRef<ClaudeSuggestHandle>(null);
  const lastSentRef = React.useRef<DraftState>(cloneDraft(EMPTY_DRAFT));
  const currentDraftRef = React.useRef<DraftState>(cloneDraft(EMPTY_DRAFT));
  const committedQuestionRef = React.useRef(false);
  const submitSeqRef = React.useRef(0);
  const claudeSeenRef = React.useRef(false);
  const lastUiSeenRef = React.useRef(0);

  const isHidden = isQuestionMode || manualHide;
  const isEmpty = isDraftEmpty(draft);
  currentDraftRef.current = draft;

  const send = React.useCallback(
    (data: string) => window.api.ptyWrite(sessionId, data),
    [sessionId],
  );

  const updateSuggestFromText = React.useCallback(
    (text: string, caretOffset: number) => {
      setSuggestState(detectSuggestTrigger(text, caretOffset));
    },
    [],
  );

  const syncDraftFromEditor = React.useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = serializeEditor(el);
    setDraft(next);
    currentDraftRef.current = next;
  }, []);

  const renderAndFocusEditor = React.useCallback(
    (nextDraft: DraftState, focus = true) => {
      const el = editorRef.current;
      if (!el) return;
      renderEditor(el, nextDraft);
      if (focus) {
        el.focus();
        placeCaretAtEnd(el);
      }
      currentDraftRef.current = nextDraft;
    },
    [],
  );

  // Detection + teardown, shell-agnostic and reconnect-safe. Periodically scan
  // the current screen for Claude's persistent UI. Present → activate and stamp
  // lastUiSeen. Absent for longer than the grace window → deactivate (Claude
  // keeps its box/status painted even mid-tool-call, so absence means it exited).
  React.useEffect(() => {
    const SCAN_MS = 800;
    const GONE_MS = 2500;
    const scan = () => {
      const buf = term.buffer.active;
      const len = buf.length;
      const start = Math.max(0, len - 25);
      let rows = "";
      for (let i = start; i < len; i++) {
        const line = buf.getLine(i);
        if (line) rows += line.translateToString(true) + "\n";
      }
      const present = looksLikeClaude(rows);
      if (present) {
        lastUiSeenRef.current = Date.now();
        if (!claudeSeenRef.current) {
          claudeSeenRef.current = true;
          setClaudeCodeActive(true);
        }
      } else if (
        claudeSeenRef.current &&
        Date.now() - lastUiSeenRef.current > GONE_MS
      ) {
        claudeSeenRef.current = false;
        setClaudeCodeActive(false);
      }
    };
    scan();
    const id = window.setInterval(scan, SCAN_MS);
    return () => clearInterval(id);
  }, [term]);

  React.useEffect(() => {
    const cb = (state: {
      ptySessionId: string;
      model?: string;
      mode?: string;
      permissionMode?: string;
      status?: string;
      contextTokens?: number;
      defaultModel?: string;
      contextWindowSize?: number;
      usedPercentage?: number;
    }) => {
      setStructuredState({
        model: state.model,
        mode: state.mode,
        permissionMode: state.permissionMode,
        status: state.status,
        contextTokens: state.contextTokens,
        defaultModel: state.defaultModel,
        contextWindowSize: state.contextWindowSize,
        usedPercentage: state.usedPercentage,
      });
    };
    window.api.onClaudeState(sessionId, cb);
    window.api
      .getClaudeState(sessionId)
      .then((s: typeof structuredState) => {
        if (s) setStructuredState(s);
      })
      .catch(() => {});
    return () => window.api.offClaudeState(sessionId, cb);
  }, [sessionId]);

  React.useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [modelMenuOpen]);

  const prevHiddenRef = React.useRef(false);
  React.useEffect(() => {
    const was = prevHiddenRef.current;
    prevHiddenRef.current = isHidden;
    if (was === isHidden) return;
    if (!document.hasFocus()) return;
    if (isHidden) {
      term.focus();
    } else {
      const el = editorRef.current;
      if (el) {
        el.focus();
        placeCaretAtEnd(el);
      }
    }
  }, [isHidden, term]);

  React.useEffect(() => {
    if (!claudeCodeActive) return;
    const handleToggle = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      if (e.key !== "g" && e.key !== "G") return;
      if (!document.hasFocus()) return;
      e.preventDefault();
      e.stopPropagation();
      setManualHide((prev) => !prev);
    };
    window.addEventListener("keydown", handleToggle, true);
    return () => window.removeEventListener("keydown", handleToggle, true);
  }, [claudeCodeActive]);

  React.useEffect(() => {
    if (!claudeCodeActive) setManualHide(false);
  }, [claudeCodeActive]);

  React.useEffect(() => {
    if (claudeCodeActive) {
      let restored: DraftState = cloneDraft(EMPTY_DRAFT);
      try {
        const raw = localStorage.getItem(draftKey(sessionId));
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed.text === "string" && parsed.text.length > 0) {
          restored = {
            text: parsed.text,
            images: Array.isArray(parsed.images) ? parsed.images : [],
          };
        }
      } catch {
        // Corrupt draft — start empty.
      }
      setDraft(restored);
      setSuggestState(null);
      setPreviewImgPath(null);
      historyIndexRef.current = null;
      historyDraftRef.current = cloneDraft(EMPTY_DRAFT);
      renderAndFocusEditor(restored, restored.text.length > 0);
    } else {
      setStatusLines([]);
      setIsQuestionMode(false);
      setIsPasting(false);
      setIsSubmitting(false);
      committedQuestionRef.current = false;
    }
  }, [claudeCodeActive, sessionId, renderAndFocusEditor]);

  React.useEffect(() => {
    if (!claudeCodeActive) return;
    const timer = window.setTimeout(() => {
      try {
        if (isDraftEmpty(draft)) {
          localStorage.removeItem(draftKey(sessionId));
        } else {
          localStorage.setItem(
            draftKey(sessionId),
            JSON.stringify({ text: draft.text, images: draft.images }),
          );
        }
      } catch {
        // Storage may be full or unavailable — non-fatal.
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, claudeCodeActive, sessionId]);

  React.useEffect(() => {
    if (!claudeCodeActive) return;

    const MIN_READ_INTERVAL = 100;
    const QUESTION_DEBOUNCE = 150;

    let lastReadAt = 0;
    let readTimer: ReturnType<typeof setTimeout> | null = null;
    let questionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let questionDebounceTarget: boolean | null = null;

    const readStatusLines = () => {
      const buf = term.buffer.active;
      const bufLen = buf.length;
      const readStart = Math.max(0, bufLen - 20);

      const rows: string[] = [];
      for (let i = readStart; i < bufLen; i++) {
        const line = buf.getLine(i);
        rows.push(line ? line.translateToString(true) : "");
      }

      // The model lines (`Set model to …`, startup banner) can sit anywhere on
      // screen — near the top on a sparse session — so scan a wider window than
      // the 2-row status footer below.
      const modelStart = Math.max(0, bufLen - 60);
      const modelRows: string[] = [];
      for (let i = modelStart; i < bufLen; i++) {
        const line = buf.getLine(i);
        modelRows.push(line ? line.translateToString(true) : "");
      }

      let switchSeen = false;
      for (let i = modelRows.length - 1; i >= 0; i--) {
        const m = modelRows[i]?.match(/Set model to (.+?)\s+and saved/i);
        if (m?.[1]) {
          const raw = m[1].trim();
          const ctx = raw.match(/\(([^)]+)\)/)?.[1];
          const name = raw.replace(/\s*\([^)]*\)\s*/, "").trim();
          setTerminalModel({
            model: name,
            ...(ctx ? { contextInfo: ctx } : {}),
          });
          switchSeen = true;
          break;
        }
      }

      // Startup banner (`Claude Code vX` then `Opus 4.8 (1M context) with …`)
      // gives the model before any reply exists. Fill only if nothing latched.
      if (!switchSeen) {
        for (let i = 0; i < modelRows.length - 1; i++) {
          if (!/Claude Code v\d/i.test(modelRows[i] ?? "")) continue;
          const banner = modelRows[i + 1] ?? "";
          const bm = banner.match(/\b(Opus|Sonnet|Haiku)\s+[\d.]+/i);
          if (bm) {
            const ctx = banner.match(/\(([^)]*context[^)]*)\)/i)?.[1];
            setTerminalModel((prev) =>
              prev ?? {
                model: bm[0].trim(),
                ...(ctx ? { contextInfo: ctx.trim() } : {}),
              },
            );
          }
          break;
        }
      }

      const isInputBoxBottom = (s: string) => s.includes("╰") && s.includes("╯");
      const isInputBoxTop = (s: string) => s.includes("╭") && s.includes("╮");

      const status: string[] = [];
      let cursor = rows.length - 1;
      while (cursor >= 0 && status.length < 2) {
        const row = rows[cursor] ?? "";
        if (isInputBoxBottom(row) || isInputBoxTop(row)) break;
        if (row.trim()) status.unshift(row);
        cursor--;
      }

      const above = rows.slice(0, cursor + 1);

      let boxBottom = -1;
      for (let i = above.length - 1; i >= 0; i--) {
        if (isInputBoxBottom(above[i] ?? "")) {
          boxBottom = i;
          break;
        }
      }
      let boxTop = -1;
      if (boxBottom >= 0) {
        for (let i = boxBottom - 1; i >= 0; i--) {
          if (isInputBoxTop(above[i] ?? "")) {
            boxTop = i;
            break;
          }
        }
      }

      const statusText = status.join(" ");
      const hasInputBox = boxTop >= 0 || boxBottom >= 0;
      const hasStatusMarker = /\[[^\]]+\]/.test(statusText);
      const hasFocusMarker = /\bfocus\b/i.test(statusText);
      const hasModeBanner = rows.some((line) =>
        /mode on|to cycle\)|esc to interrupt|for agents|accept edits|bypass permissions|plan mode|⏵⏵/i.test(
          line,
        ),
      );
      const menuMode = rows.some((line) =>
        /\b(resume session|select a|select an|switch to|choose)\b|\(\s*\d+\s+of\s+\d+\s*\)|to show all projects|only show current branch/i.test(
          line,
        ),
      );
      const exitBanner = rows.some((line) =>
        /press ctrl-?c again/i.test(line),
      );
      const questionMode =
        menuMode ||
        (!exitBanner &&
          !hasInputBox &&
          !hasStatusMarker &&
          !hasFocusMarker &&
          !hasModeBanner);

      // Claude keeps its input box / status line / menu painted the whole time
      // it runs; they disappear only once it exits back to the shell prompt.
      // Stamp the last time any of them was visible so the watchdog can tear the
      // overlay down — this is the shell-agnostic deactivation signal (works on
      // cmd/PowerShell, which emit no shell-integration escape sequences).
      const claudeUiPresent =
        hasInputBox ||
        hasStatusMarker ||
        hasFocusMarker ||
        hasModeBanner ||
        menuMode ||
        exitBanner;
      if (claudeUiPresent) lastUiSeenRef.current = Date.now();

      setStatusLines((prev) =>
        prev.length === status.length &&
        prev.every((value, i) => value === status[i])
          ? prev
          : status,
      );

      if (questionMode === committedQuestionRef.current) {
        if (questionDebounceTimer) {
          clearTimeout(questionDebounceTimer);
          questionDebounceTimer = null;
          questionDebounceTarget = null;
        }
      } else if (questionDebounceTarget !== questionMode) {
        if (questionDebounceTimer) clearTimeout(questionDebounceTimer);
        questionDebounceTarget = questionMode;
        questionDebounceTimer = setTimeout(() => {
          committedQuestionRef.current = questionMode;
          setIsQuestionMode(questionMode);
          questionDebounceTimer = null;
          questionDebounceTarget = null;
        }, QUESTION_DEBOUNCE);
      }
    };

    const scheduleRead = () => {
      const now = Date.now();
      const elapsed = now - lastReadAt;
      if (elapsed >= MIN_READ_INTERVAL) {
        lastReadAt = now;
        readStatusLines();
        return;
      }
      if (readTimer) return;
      readTimer = setTimeout(() => {
        readTimer = null;
        lastReadAt = Date.now();
        readStatusLines();
      }, MIN_READ_INTERVAL - elapsed);
    };

    readStatusLines();
    const disp = term.onRender(scheduleRead);
    return () => {
      disp.dispose();
      if (readTimer) clearTimeout(readTimer);
      if (questionDebounceTimer) clearTimeout(questionDebounceTimer);
    };
  }, [term, claudeCodeActive]);

  React.useEffect(() => {
    if (!claudeCodeActive) return;
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)
        return;
      if (!document.hasFocus()) return;
      if (document.activeElement === editorRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const el = editorRef.current;
      if (el) {
        el.focus();
        placeCaretAtEnd(el);
      }
    };
    window.addEventListener("keydown", handleTab, true);
    return () => window.removeEventListener("keydown", handleTab, true);
  }, [claudeCodeActive]);

  React.useEffect(() => {
    return () => {
      if (errorTimerRef.current != null) clearTimeout(errorTimerRef.current);
      submitSeqRef.current++;
    };
  }, []);

  const showError = React.useCallback((msg: string) => {
    if (errorTimerRef.current != null) clearTimeout(errorTimerRef.current);
    setErrorMsg(msg);
    errorTimerRef.current = setTimeout(() => setErrorMsg(null), 3000);
  }, []);

  const restoreDraft = React.useCallback(
    (nextDraft: DraftState) => {
      const restored = cloneDraft(nextDraft);
      setDraft(restored);
      historyIndexRef.current = null;
      setSuggestState(null);
      renderAndFocusEditor(restored);
    },
    [renderAndFocusEditor],
  );

  const persistHistory = React.useCallback((nextDraft: DraftState) => {
    const key = getDraftHistoryKey(nextDraft);
    if (!key && nextDraft.images.length === 0) return;

    const nextParts = draftToParts(nextDraft);
    const current = loadHistory();
    const next = [
      ...current.filter(
        (entry) =>
          Array.isArray(entry) &&
          getDraftHistoryKey(partsToDraft(entry)) !== key,
      ),
      nextParts,
    ].slice(-50);

    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal.
    }
    setHistory(next);
  }, []);

  const sendDraft = React.useCallback(
    async (submissionDraft: DraftState) => {
      const seq = ++submitSeqRef.current;
      const parts = consolidateParts(draftToSendParts(submissionDraft));
      if (parts.length === 0) return;
      const plainText = submissionDraft.text.trim();

      // Clear Claude's input before pasting. Ctrl+C reliably wipes it (even
      // multi-line). If the input was already empty, Ctrl+C raises the "Press
      // Ctrl-C again to exit" banner — the printable BPM paste that follows
      // dismisses it safely. The one case we must avoid is sending Ctrl+C while
      // the banner is ALREADY showing (it would confirm the exit), so scan the
      // buffer first and use Ctrl+U in that case.
      const banner = detectExitBanner(term);
      if (banner) {
        send("\x15");
        await pause(80);
      } else {
        send("\x03");
        await pause(80);
      }
      if (submitSeqRef.current !== seq) return;

      for (const part of parts) {
        if (part.type === "text") {
          if (part.content.length > 0) {
            send(BPM_START + part.content + BPM_END);
          }
        } else {
          send(BPM_START + part.path + " " + BPM_END);
        }
        await pause(part.type === "text" ? 10 : 50);
        if (submitSeqRef.current !== seq) return;
      }

      const lineCount = Math.max(1, plainText.split("\n").length);
      await pause(Math.min(400, 50 + lineCount * 2));
      if (submitSeqRef.current !== seq) return;

      send("\r");
    },
    [send, term],
  );

  const handleSend = React.useCallback(async () => {
    const liveDraft = currentDraftRef.current;
    if (isDraftEmpty(liveDraft) || isSubmitting || isPasting) return;

    const submissionDraft = cloneDraft(liveDraft);
    persistHistory(submissionDraft);
    lastSentRef.current = cloneDraft(submissionDraft);
    historyIndexRef.current = null;
    historyDraftRef.current = cloneDraft(EMPTY_DRAFT);
    setSuggestState(null);
    setDraft(cloneDraft(EMPTY_DRAFT));
    if (editorRef.current) editorRef.current.textContent = "";
    currentDraftRef.current = cloneDraft(EMPTY_DRAFT);
    setIsSubmitting(true);

    try {
      await sendDraft(submissionDraft);
    } finally {
      setIsSubmitting(false);
    }
  }, [isPasting, isSubmitting, persistHistory, sendDraft]);

  const handleInput = React.useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = serializeEditor(el);
    setDraft(next);
    currentDraftRef.current = next;
    historyIndexRef.current = null;

    if (!next.text.startsWith("/")) {
      setSuggestState(null);
      return;
    }
    const caret = getCaretOffset(el) ?? next.text.length;
    updateSuggestFromText(next.text, caret);
  }, [updateSuggestFromText]);

  const handleEditorClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const removeBtn = target.closest(
        ".claude-prompt-image-chip-remove",
      ) as HTMLElement | null;
      if (removeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const chip = removeBtn.closest(
          ".claude-prompt-image-chip",
        ) as HTMLElement | null;
        if (chip) {
          chip.remove();
          syncDraftFromEditor();
          const el = editorRef.current;
          if (el) {
            el.focus();
            placeCaretAtEnd(el);
          }
        }
        return;
      }
      const chip = target.closest(
        ".claude-prompt-image-chip",
      ) as HTMLElement | null;
      if (chip?.dataset.imgpath) {
        e.stopPropagation();
        setPreviewImgPath(chip.dataset.imgpath);
      }
    },
    [syncDraftFromEditor],
  );

  const handlePaste = React.useCallback(
    async (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const fallbackText =
        e.nativeEvent.clipboardData?.getData("text/plain") ?? "";
      const savedRange = (() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        const r = sel.getRangeAt(0);
        const editor = editorRef.current;
        if (!editor || !editor.contains(r.startContainer)) return null;
        return r.cloneRange();
      })();

      setIsPasting(true);
      try {
        const clipboardData = await extractAllClipboardData(e.nativeEvent);
        let insertedText = "";
        const imageBlobs: Blob[] = [];

        for (const data of clipboardData) {
          if (data.image) imageBlobs.push(data.image);
          else if (data.text) insertedText += data.text;
        }

        const imagePaths: string[] = [];
        if (imageBlobs.length > 0) {
          const settled = await Promise.allSettled(
            imageBlobs.map((blob) => createTempImageFromBlob(blob)),
          );
          let hadError = false;
          for (const result of settled) {
            if (result.status === "fulfilled") imagePaths.push(result.value);
            else hadError = true;
          }
          if (hadError) {
            showError("Image too large or unsupported format (max 5 MB)");
          }
        }

        if (!insertedText && imagePaths.length === 0 && fallbackText) {
          insertedText = fallbackText;
        }

        const editor = editorRef.current;
        if (!editor) return;

        editor.focus();
        if (savedRange && editor.contains(savedRange.startContainer)) {
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(savedRange);
        } else {
          placeCaretAtEnd(editor);
        }

        const existingImageCount = (currentDraftRef.current.images ?? []).length;
        if (insertedText || imagePaths.length > 0) {
          insertPartsAtCaret(
            editor,
            insertedText,
            imagePaths,
            existingImageCount + 1,
          );
        }

        syncDraftFromEditor();
        historyIndexRef.current = null;

        if (currentDraftRef.current.text.startsWith("/")) {
          const caret =
            getCaretOffset(editor) ?? currentDraftRef.current.text.length;
          updateSuggestFromText(currentDraftRef.current.text, caret);
        } else {
          setSuggestState(null);
        }
      } catch (err) {
        console.error("Claude prompt paste failed", err);
        showError("Paste failed");
      } finally {
        setIsPasting(false);
      }
    },
    [showError, syncDraftFromEditor, updateSuggestFromText],
  );

  const fetchSlashFn = React.useCallback(
    async (query: string): Promise<PromptSuggestion[]> => {
      const q = query.toLowerCase();
      return CLAUDE_SLASH_COMMANDS.filter(
        (cmd) =>
          cmd.name.includes(q) ||
          cmd.desc.toLowerCase().includes(q) ||
          cmd.aliases?.some((alias) => alias.toLowerCase().includes(q)),
      ).map((cmd) => ({
        id: cmd.name,
        display: cmd.name,
        subtext: cmd.aliases?.length
          ? `${cmd.desc} (${cmd.aliases.join(", ")})`
          : cmd.desc,
        icon: "cmd" as const,
        takesArg: cmd.takesArg,
      }));
    },
    [],
  );

  const fetchModelsFn = React.useCallback(
    async (query: string): Promise<PromptSuggestion[]> => {
      const q = query.toLowerCase();
      return CLAUDE_MODELS.filter(
        (entry) =>
          entry.name.toLowerCase().includes(q) ||
          entry.desc.toLowerCase().includes(q) ||
          entry.aliases?.some((alias) => alias.toLowerCase().includes(q)),
      ).map((entry) => ({
        id: entry.name,
        display: entry.name,
        subtext: entry.aliases?.length
          ? `${entry.desc} (${entry.aliases.join(", ")})`
          : entry.desc,
        icon: "model" as const,
      }));
    },
    [],
  );

  const onSlashSelect = React.useCallback(
    (item: PromptSuggestion, submit?: boolean) => {
      const name = item.display ?? "";
      const needsComplement = name === "/model";
      const noSubmit = needsComplement || item.takesArg === true;
      const effectiveSubmit = submit && !noSubmit;
      const nextText = name + (effectiveSubmit ? "" : " ");
      const nextDraft: DraftState = { text: nextText, images: [] };
      setDraft(nextDraft);
      renderAndFocusEditor(nextDraft);
      setSuggestState(needsComplement ? { kind: "model", query: "" } : null);
      if (effectiveSubmit) void handleSend();
    },
    [handleSend, renderAndFocusEditor],
  );

  const onModelSelect = React.useCallback(
    (item: PromptSuggestion, submit?: boolean) => {
      const nextText = `/model ${item.display ?? ""}`;
      const nextDraft: DraftState = { text: nextText, images: [] };
      setDraft(nextDraft);
      renderAndFocusEditor(nextDraft);
      setSuggestState(null);
      if (submit) void handleSend();
    },
    [handleSend, renderAndFocusEditor],
  );

  const onModelHighlight = React.useCallback(
    (item: PromptSuggestion) => {
      const nextText = `/model ${item.display ?? ""}`;
      const nextDraft: DraftState = { text: nextText, images: [] };
      setDraft(nextDraft);
      renderAndFocusEditor(nextDraft);
    },
    [renderAndFocusEditor],
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        send("\x1b[Z");
        return;
      }

      if (suggestState != null && suggestRef.current) {
        const consumed = suggestRef.current.handleKeyDown(e);
        if (consumed) return;
      }

      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        term.focus();
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (previewImgPath != null) {
          setPreviewImgPath(null);
          return;
        }
        send("\x03");
        if (
          isDraftEmpty(currentDraftRef.current) &&
          !isDraftEmpty(lastSentRef.current)
        ) {
          restoreDraft(lastSentRef.current);
        }
        return;
      }

      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        void handleSend();
        return;
      }

      if (
        e.key === "ArrowUp" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        suggestState == null
      ) {
        const liveDraft = currentDraftRef.current;
        if (history.length > 0 && isCaretOnFirstLine(editorRef.current!)) {
          e.preventDefault();
          if (historyIndexRef.current == null) {
            historyDraftRef.current = cloneDraft(liveDraft);
            historyIndexRef.current = history.length - 1;
          } else if (historyIndexRef.current > 0) {
            historyIndexRef.current--;
          }
          const nextDraft = partsToDraft(
            history[historyIndexRef.current] ?? [],
          );
          setDraft(nextDraft);
          renderAndFocusEditor(nextDraft);
          setSuggestState(null);
          return;
        }
      }

      if (
        e.key === "ArrowDown" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        suggestState == null &&
        historyIndexRef.current != null
      ) {
        if (isCaretOnLastLine(editorRef.current!)) {
          e.preventDefault();
          if (historyIndexRef.current < history.length - 1) {
            historyIndexRef.current++;
            const nextDraft = partsToDraft(
            history[historyIndexRef.current] ?? [],
          );
            setDraft(nextDraft);
            renderAndFocusEditor(nextDraft);
          } else {
            historyIndexRef.current = null;
            const restored = cloneDraft(historyDraftRef.current);
            setDraft(restored);
            renderAndFocusEditor(restored);
          }
          setSuggestState(null);
          return;
        }
      }
    },
    [
      handleSend,
      history,
      previewImgPath,
      restoreDraft,
      suggestState,
      renderAndFocusEditor,
      send,
      term,
    ],
  );

  const handleModelSwitch = React.useCallback(
    (modelId: string) => {
      void sendDraft({ text: `/model ${modelId}`, images: [] });
    },
    [sendDraft],
  );

  const currentModelId = React.useMemo(() => {
    if (terminalModel) {
      const t = terminalModel.model.toLowerCase();
      const oneM = /1m/i.test(terminalModel.contextInfo ?? "");
      if (t.includes("sonnet")) return "sonnet";
      const m = t.match(/opus\s*(\d)[.\s-]?(\d)/);
      if (m) return `claude-opus-${m[1]}-${m[2]}${oneM ? "[1m]" : ""}`;
    }
    const base = matchQuickSwitchId(structuredState?.model);
    if (
      base &&
      base !== "sonnet" &&
      !base.includes("[1m]") &&
      (structuredState?.contextWindowSize ?? 0) >= 1_000_000
    ) {
      return `${base}[1m]`;
    }
    return base;
  }, [terminalModel, structuredState?.model, structuredState?.contextWindowSize]);

  const is1M = React.useMemo(() => {
    if (structuredState?.contextWindowSize != null) {
      return structuredState.contextWindowSize >= 1_000_000;
    }
    if (terminalModel) return /1m/i.test(terminalModel.contextInfo ?? "");
    if (/\[1m\]/i.test(structuredState?.model ?? "")) return true;
    if (/1m/i.test(parseStatusLines(statusLines).contextInfo ?? "")) return true;
    return /\[1m\]/i.test(structuredState?.defaultModel ?? "");
  }, [
    terminalModel,
    structuredState?.model,
    structuredState?.defaultModel,
    structuredState?.contextWindowSize,
    statusLines,
  ]);

  const parsedStatus = React.useMemo(() => {
    const scraped = parseStatusLines(statusLines);
    const fromFiles = prettyModel(structuredState?.model);
    // model + context come as a unit from one source — never mix a model name
    // from one with a context tag from another (a stale default leaks 1M).
    const model = terminalModel
      ? terminalModel.model
      : (fromFiles.model ?? scraped.model);
    const contextInfo = terminalModel
      ? terminalModel.contextInfo
      : (fromFiles.contextInfo ?? scraped.contextInfo);
    const base =
      structuredState || terminalModel
        ? {
            ...scraped,
            ...(model ? { model } : {}),
            ...(contextInfo ? { contextInfo } : {}),
            mode: prettyMode(structuredState?.permissionMode) ?? scraped.mode,
          }
        : scraped;
    if (base.progress == null && structuredState?.usedPercentage != null) {
      return {
        ...base,
        progress: Math.min(100, Math.round(structuredState.usedPercentage)),
        contextInfo: base.contextInfo ?? (is1M ? "1M" : "200k"),
      };
    }
    if (base.progress == null && structuredState?.contextTokens != null) {
      const windowSize = is1M ? 1_000_000 : 200_000;
      return {
        ...base,
        progress: Math.min(
          100,
          Math.round((structuredState.contextTokens / windowSize) * 100),
        ),
        contextInfo: base.contextInfo ?? (is1M ? "1M" : "200k"),
      };
    }
    return base;
  }, [statusLines, structuredState, terminalModel, is1M]);
  const hasStatus =
    parsedStatus.model != null ||
    parsedStatus.mode != null ||
    parsedStatus.focused ||
    parsedStatus.progress != null;
  const hasScrapedStatusline = React.useMemo(
    () => parseStatusLines(statusLines).model != null,
    [statusLines],
  );

  if (!claudeCodeActive) return null;

  return (
    <>
      {manualHide && !isQuestionMode && (
        <button
          className="claude-prompt-restore"
          title="Restore Claude prompt (Ctrl+G)"
          onClick={() => setManualHide(false)}
        >
          <ClaudeLogo />
        </button>
      )}
      <div
        className={`claude-prompt${hasScrapedStatusline ? "" : " claude-prompt-compact"}`}
        style={isHidden ? { display: "none" } : undefined}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (
            target.closest(".claude-prompt-image-chip") ||
            target.closest(".claude-prompt-actions") ||
            target.closest(".claude-prompt-editor")
          ) {
            return;
          }
          const el = editorRef.current;
          if (el) {
            el.focus();
            placeCaretAtEnd(el);
          }
        }}
      >
        <div className="claude-prompt-row">
          <div className="claude-prompt-icon" aria-hidden="true">
            <ClaudeLogo />
          </div>
          <div
            ref={editorRef}
            className="claude-prompt-editor scrollbar-hover"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Tell Claude what to do... (/ commands, ↑ history)"
            data-empty={isEmpty ? "true" : undefined}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onClick={handleEditorClick}
            role="textbox"
            aria-multiline="true"
            aria-label="Prompt input"
            spellCheck={false}
          />
          <div className="claude-prompt-actions">
            <div className="claude-prompt-model" ref={modelMenuRef}>
              <button
                type="button"
                className="claude-prompt-model-trigger"
                title="Switch model"
                onClick={() => setModelMenuOpen((o) => !o)}
              >
                {MODEL_QUICK_SWITCHES.find((m) => m.id === currentModelId)
                  ?.title ?? "Model"}
                <ChevronDown size={11} />
              </button>
              {modelMenuOpen && (
                <div className="claude-prompt-model-menu">
                  {MODEL_QUICK_SWITCHES.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      className={`claude-prompt-model-item${
                        m.id === currentModelId ? " is-active" : ""
                      }`}
                      onClick={() => {
                        handleModelSwitch(m.id);
                        setModelMenuOpen(false);
                      }}
                    >
                      {m.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {errorMsg && <div className="claude-prompt-error">{errorMsg}</div>}
        <div className="claude-prompt-hints">
          {isPasting
            ? "Processing paste..."
            : isSubmitting
              ? "Submitting prompt..."
              : suggestState != null
                ? "Enter ↵ select & send · Tab complete · Esc close"
                : "Enter ↵ send · Shift+Enter newline · Tab terminal"}
        </div>
        {hasStatus && (
          <div className="claude-prompt-footer" aria-hidden="true">
            {parsedStatus.mode && (
              <span
                className={`claude-prompt-chip claude-prompt-chip-mode claude-prompt-chip-mode-${modeKey(
                  parsedStatus.mode,
                )}`}
              >
                <Sparkles size={10} />
                <span className="claude-prompt-chip-label">
                  {parsedStatus.mode}
                </span>
              </span>
            )}
            {parsedStatus.model && (
              <span className="claude-prompt-chip">
                <span className="claude-prompt-chip-label">
                  {parsedStatus.model}
                </span>
                {parsedStatus.contextInfo && (
                  <span className="claude-prompt-chip-sub">
                    {parsedStatus.contextInfo}
                  </span>
                )}
              </span>
            )}
            {parsedStatus.focused && (
              <span className="claude-prompt-chip claude-prompt-chip-focus">
                <span className="claude-prompt-chip-dot" />
                <span className="claude-prompt-chip-label">focus</span>
              </span>
            )}
            {parsedStatus.progress != null && (
              <span className="claude-prompt-progress">
                <span className="claude-prompt-progress-track">
                  <span
                    className="claude-prompt-progress-bar"
                    style={{
                      width: `${Math.min(100, Math.max(0, parsedStatus.progress))}%`,
                      background:
                        parsedStatus.progress >= 75
                          ? "#ef4444"
                          : parsedStatus.progress >= 60
                            ? "#f97316"
                            : parsedStatus.progress >= 30
                              ? "#eab308"
                              : "#22c55e",
                    }}
                  />
                </span>
                <span className="claude-prompt-progress-label">
                  {parsedStatus.progress}%
                </span>
              </span>
            )}
          </div>
        )}
        {suggestState != null && (
          <ClaudePromptSuggest
            ref={suggestRef}
            isOpen={true}
            query={suggestState.query}
            fetchFn={
              suggestState.kind === "model" ? fetchModelsFn : fetchSlashFn
            }
            onSelect={suggestState.kind === "model" ? onModelSelect : onSlashSelect}
            onHighlight={
              suggestState.kind === "model" ? onModelHighlight : undefined
            }
            onClose={() => setSuggestState(null)}
          />
        )}
        {previewImgPath != null && (
          <ImageMagnifier
            path={previewImgPath}
            onClose={() => setPreviewImgPath(null)}
          />
        )}
      </div>
    </>
  );
});

function ImageMagnifier({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const [src, setSrc] = React.useState<string | null>(null);
  const [scale, setScale] = React.useState(1);

  React.useEffect(() => {
    let cancelled = false;
    window.api
      .getImageFull(path)
      .then((r) => {
        if (!cancelled) setSrc(r.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div className="claude-prompt-magnifier" onClick={onClose}>
      <div
        className="claude-prompt-magnifier-controls"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          title="Zoom in"
          onClick={() => setScale((s) => Math.min(20, s * 1.25))}
        >
          <ZoomIn size={16} />
        </button>
        <button
          title="Zoom out"
          onClick={() => setScale((s) => Math.max(0.1, s / 1.25))}
        >
          <ZoomOut size={16} />
        </button>
        <button title="Reset" onClick={() => setScale(1)}>
          <RotateCcw size={16} />
        </button>
        <button title="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {src && (
        <img
          src={src}
          alt=""
          className="claude-prompt-magnifier-img"
          style={{ transform: `scale(${scale})` }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>,
    document.body,
  );
}

export { ClaudePrompt };
