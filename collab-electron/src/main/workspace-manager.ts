import {
  readFile,
  writeFile,
  rename,
  mkdir,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as crypto from "node:crypto";
import { COLLAB_DIR } from "./paths";

const WS_DIR = join(COLLAB_DIR, "workspaces");
const INDEX_FILE = join(COLLAB_DIR, "workspaces.json");
const LEGACY_STATE_FILE = join(COLLAB_DIR, "canvas-state.json");

interface TileState {
  id: string;
  type: "term" | "note" | "code" | "image" | "graph" | "browser";
  x: number;
  y: number;
  width: number;
  height: number;
  filePath?: string;
  folderPath?: string;
  url?: string | null;
  workspacePath?: string;
  ptySessionId?: string;
  cwd?: string;
  userTitle?: string;
  autoTitle?: string;
  zIndex: number;
}

interface FrameState {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  color: string;
}

export interface CanvasState {
  version: 1;
  tiles: TileState[];
  frames?: FrameState[];
  viewport: {
    centerX: number;
    centerY: number;
    zoom: number;
  };
}

export interface TabState {
  id: string;
  name: string;
  state: CanvasState;
}

export interface TabMeta {
  id: string;
  name: string;
}

export interface WorkspaceMeta {
  id: string;
  name: string;
  color: string;
  createdAt: number;
  lastFocusedAt: number;
}

interface WorkspaceFile {
  meta: WorkspaceMeta;
  tabs: TabState[];
  activeTabId: string;
}

interface IndexFile {
  version: 1;
  activeId: string | null;
  order: string[];
}

const COLORS = [
  "#6ea8fe",
  "#75d0a0",
  "#e6a957",
  "#d98abf",
  "#7fd1d6",
  "#d97c7c",
  "#b39ddb",
  "#c0c97f",
];

function sanitizeCoord(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function emptyState(): CanvasState {
  return {
    version: 1,
    tiles: [],
    viewport: { centerX: 0, centerY: 0, zoom: 1 },
  };
}

function newId(): string {
  return `ws-${crypto.randomUUID()}`;
}

function newTabId(): string {
  return `tab-${crypto.randomUUID()}`;
}

function emptyTab(name: string): TabState {
  return { id: newTabId(), name, state: emptyState() };
}

/** Next "Tab N" name that doesn't collide with existing ones. */
function nextTabName(tabs: TabState[]): string {
  let max = 0;
  for (const t of tabs) {
    const m = /^Tab (\d+)$/.exec(t.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Tab ${max + 1}`;
}

function wsFilePath(id: string): string {
  return join(WS_DIR, `${id}.json`);
}

async function ensureDir(): Promise<void> {
  if (!existsSync(WS_DIR)) {
    await mkdir(WS_DIR, { recursive: true });
  }
}

async function atomicWrite(path: string, data: unknown): Promise<void> {
  await ensureDir();
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function normalizeState(state: CanvasState | null): CanvasState {
  if (!state || state.version !== 1) return emptyState();
  for (const tile of state.tiles ?? []) {
    tile.x = sanitizeCoord(tile.x);
    tile.y = sanitizeCoord(tile.y);
  }
  if (!state.viewport) state.viewport = emptyState().viewport;
  return state;
}

/**
 * Upgrades an on-disk workspace into the current shape. Pre-tab files stored a
 * single `state`; those are wrapped into one tab. Always returns a workspace
 * with at least one tab and a valid activeTabId.
 */
function migrate(raw: unknown): WorkspaceFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.meta) return null;
  const meta = r.meta as WorkspaceMeta;

  let tabs: TabState[];
  if (Array.isArray(r.tabs) && r.tabs.length > 0) {
    tabs = (r.tabs as TabState[]).map((t) => ({
      id: t.id ?? newTabId(),
      name: t.name ?? "Tab",
      state: normalizeState(t.state ?? null),
    }));
  } else {
    tabs = [
      {
        id: newTabId(),
        name: "Tab 1",
        state: normalizeState((r.state as CanvasState) ?? null),
      },
    ];
  }

  let activeTabId = r.activeTabId as string | undefined;
  if (!activeTabId || !tabs.some((t) => t.id === activeTabId)) {
    activeTabId = tabs[0]!.id;
  }
  return { meta, tabs, activeTabId };
}

async function writeWorkspace(file: WorkspaceFile): Promise<void> {
  await atomicWrite(wsFilePath(file.meta.id), file);
}

async function readWorkspace(id: string): Promise<WorkspaceFile | null> {
  const raw = await readJson<unknown>(wsFilePath(id));
  const file = migrate(raw);
  if (!file) return null;
  // Persist the one-time upgrade of pre-tab files so generated tab ids stay
  // stable across subsequent reads.
  if (raw && typeof raw === "object" && !("tabs" in raw)) {
    await writeWorkspace(file);
  }
  return file;
}

let cachedIndex: IndexFile | null = null;

async function loadIndex(): Promise<IndexFile> {
  if (cachedIndex) return cachedIndex;
  cachedIndex = await initIndex();
  return cachedIndex;
}

async function saveIndex(idx: IndexFile): Promise<void> {
  cachedIndex = idx;
  await atomicWrite(INDEX_FILE, idx);
}

/**
 * First-run bootstrap: migrate a pre-existing single canvas into a default
 * workspace, or create an empty one. Always leaves a valid index with at
 * least one workspace and a defined activeId.
 */
async function initIndex(): Promise<IndexFile> {
  const existing = await readJson<IndexFile>(INDEX_FILE);
  if (existing && existing.order.length > 0) {
    if (!existing.activeId || !existing.order.includes(existing.activeId)) {
      existing.activeId = existing.order[0] ?? null;
    }
    return existing;
  }

  await ensureDir();
  const id = newId();
  const now = Date.now();
  const legacy = await readJson<CanvasState>(LEGACY_STATE_FILE);
  const meta: WorkspaceMeta = {
    id,
    name: "Workspace 1",
    color: COLORS[0]!,
    createdAt: now,
    lastFocusedAt: now,
  };
  const firstTab: TabState = {
    id: newTabId(),
    name: "Tab 1",
    state: normalizeState(legacy),
  };
  await writeWorkspace({ meta, tabs: [firstTab], activeTabId: firstTab.id });
  if (legacy) {
    await unlink(LEGACY_STATE_FILE).catch(() => {});
  }
  const idx: IndexFile = { version: 1, activeId: id, order: [id] };
  await atomicWrite(INDEX_FILE, idx);
  return idx;
}

function tabOf(file: WorkspaceFile, tabId: string): TabState | undefined {
  return file.tabs.find((t) => t.id === tabId);
}

// ── Workspaces ──

export async function listWorkspaces(): Promise<{
  activeId: string | null;
  workspaces: WorkspaceMeta[];
}> {
  const idx = await loadIndex();
  const workspaces: WorkspaceMeta[] = [];
  for (const id of idx.order) {
    const file = await readWorkspace(id);
    if (file) workspaces.push(file.meta);
  }
  return { activeId: idx.activeId, workspaces };
}

export async function setActiveWorkspace(id: string): Promise<void> {
  const idx = await loadIndex();
  if (!idx.order.includes(id)) return;
  idx.activeId = id;
  await saveIndex(idx);
  const file = await readWorkspace(id);
  if (file) {
    file.meta.lastFocusedAt = Date.now();
    await writeWorkspace(file);
  }
}

export async function createWorkspace(
  name?: string,
): Promise<WorkspaceMeta> {
  const idx = await loadIndex();
  const id = newId();
  const now = Date.now();
  const meta: WorkspaceMeta = {
    id,
    name: name?.trim() || `Workspace ${idx.order.length + 1}`,
    color: COLORS[idx.order.length % COLORS.length]!,
    createdAt: now,
    lastFocusedAt: now,
  };
  const firstTab = emptyTab("Tab 1");
  await writeWorkspace({ meta, tabs: [firstTab], activeTabId: firstTab.id });
  idx.order.push(id);
  await saveIndex(idx);
  return meta;
}

export async function renameWorkspace(
  id: string,
  name: string,
): Promise<void> {
  const file = await readWorkspace(id);
  if (!file) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  file.meta.name = trimmed;
  await writeWorkspace(file);
}

export async function setColor(id: string, color: string): Promise<void> {
  const file = await readWorkspace(id);
  if (!file) return;
  file.meta.color = color;
  await writeWorkspace(file);
}

/**
 * Deletes a workspace. The last remaining workspace cannot be deleted. Returns
 * the new active id so the renderer can move to a surviving neighbour.
 */
export async function deleteWorkspace(
  id: string,
): Promise<{ activeId: string | null; deleted: boolean }> {
  const idx = await loadIndex();
  if (idx.order.length <= 1 || !idx.order.includes(id)) {
    return { activeId: idx.activeId, deleted: false };
  }
  const removedAt = idx.order.indexOf(id);
  idx.order.splice(removedAt, 1);
  if (idx.activeId === id) {
    idx.activeId = idx.order[Math.max(0, removedAt - 1)] ?? idx.order[0]!;
  }
  await saveIndex(idx);
  await unlink(wsFilePath(id)).catch(() => {});
  return { activeId: idx.activeId, deleted: true };
}

export async function reorderWorkspaces(order: string[]): Promise<void> {
  const idx = await loadIndex();
  const known = new Set(idx.order);
  const next = order.filter((wid) => known.has(wid));
  for (const wid of idx.order) {
    if (!next.includes(wid)) next.push(wid);
  }
  idx.order = next;
  await saveIndex(idx);
}

/** Every tab's canvas in a workspace — used to reap pty sessions on delete. */
export async function listTabStates(id: string): Promise<CanvasState[]> {
  const file = await readWorkspace(id);
  return file ? file.tabs.map((t) => t.state) : [];
}

// ── Tabs ──

export async function getTabs(workspaceId: string): Promise<{
  activeTabId: string | null;
  tabs: TabMeta[];
}> {
  const file = await readWorkspace(workspaceId);
  if (!file) return { activeTabId: null, tabs: [] };
  return {
    activeTabId: file.activeTabId,
    tabs: file.tabs.map((t) => ({ id: t.id, name: t.name })),
  };
}

const loadedTabs = new Set<string>();

export async function loadTabState(
  workspaceId: string,
  tabId: string,
): Promise<CanvasState | null> {
  const file = await readWorkspace(workspaceId);
  const tab = file && tabOf(file, tabId);
  if (tab) {
    loadedTabs.add(`${workspaceId}/${tabId}`);
    return normalizeState(tab.state);
  }
  return null;
}

export async function saveTabState(
  workspaceId: string,
  tabId: string,
  state: CanvasState,
): Promise<void> {
  const file = await readWorkspace(workspaceId);
  if (!file) return;
  const tab = tabOf(file, tabId);
  if (!tab) return;
  const normalized = normalizeState(state);
  const key = `${workspaceId}/${tabId}`;
  if (
    normalized.tiles.length === 0 &&
    tab.state.tiles.length > 0 &&
    !loadedTabs.has(key)
  ) {
    console.warn(
      "[workspace-manager] Rejected save: would erase %d tiles for tab %s",
      tab.state.tiles.length,
      tabId,
    );
    return;
  }
  tab.state = normalized;
  await writeWorkspace(file);
}

export async function setActiveTab(
  workspaceId: string,
  tabId: string,
): Promise<void> {
  const file = await readWorkspace(workspaceId);
  if (!file || !tabOf(file, tabId)) return;
  file.activeTabId = tabId;
  await writeWorkspace(file);
}

export async function createTab(
  workspaceId: string,
  name?: string,
): Promise<TabMeta | null> {
  const file = await readWorkspace(workspaceId);
  if (!file) return null;
  const tab = emptyTab(name?.trim() || nextTabName(file.tabs));
  file.tabs.push(tab);
  await writeWorkspace(file);
  return { id: tab.id, name: tab.name };
}

export async function renameTab(
  workspaceId: string,
  tabId: string,
  name: string,
): Promise<void> {
  const file = await readWorkspace(workspaceId);
  if (!file) return;
  const tab = tabOf(file, tabId);
  const trimmed = name.trim();
  if (!tab || !trimmed) return;
  tab.name = trimmed;
  await writeWorkspace(file);
}

/**
 * Deletes a tab. The last remaining tab cannot be deleted. Returns the new
 * active tab id so the renderer can move to a surviving neighbour.
 */
export async function deleteTab(
  workspaceId: string,
  tabId: string,
): Promise<{ activeTabId: string | null; deleted: boolean }> {
  const file = await readWorkspace(workspaceId);
  if (!file || file.tabs.length <= 1) {
    return { activeTabId: file?.activeTabId ?? null, deleted: false };
  }
  const removedAt = file.tabs.findIndex((t) => t.id === tabId);
  if (removedAt === -1) {
    return { activeTabId: file.activeTabId, deleted: false };
  }
  file.tabs.splice(removedAt, 1);
  if (file.activeTabId === tabId) {
    file.activeTabId =
      file.tabs[Math.max(0, removedAt - 1)]!.id;
  }
  await writeWorkspace(file);
  return { activeTabId: file.activeTabId, deleted: true };
}

// ── Active workspace/tab convenience (used by canvas:* autosave) ──

async function activeRef(): Promise<{ workspaceId: string; tabId: string } | null> {
  const idx = await loadIndex();
  if (!idx.activeId) return null;
  const file = await readWorkspace(idx.activeId);
  if (!file) return null;
  return { workspaceId: idx.activeId, tabId: file.activeTabId };
}

export async function loadActiveState(): Promise<CanvasState | null> {
  const ref = await activeRef();
  return ref ? loadTabState(ref.workspaceId, ref.tabId) : null;
}

export async function saveActiveState(state: CanvasState): Promise<void> {
  const ref = await activeRef();
  if (ref) await saveTabState(ref.workspaceId, ref.tabId, state);
}
