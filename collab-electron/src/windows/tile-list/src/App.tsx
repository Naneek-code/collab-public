import type { Icon } from "@phosphor-icons/react";
import {
  Terminal,
  Browser,
  ChartLineUp,
  Note,
  Code,
  Image,
} from "@phosphor-icons/react";
import { CaretRight, Crosshair } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type TileType = "term" | "note" | "code" | "image" | "graph" | "browser";

interface TileEntry {
  id: string;
  type: TileType;
  title: string;
  description: string;
  status: "running" | "exited" | "idle" | null;
  frameId: string | null;
}

interface FrameEntry {
  id: string;
  title: string;
  color: string;
}

function isTileEntry(value: unknown): value is TileEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.type === "string" &&
    typeof e.title === "string" &&
    typeof e.description === "string"
  );
}

function isFrameEntry(value: unknown): value is FrameEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.title === "string";
}

const TYPE_ICONS: Record<TileType, { icon: Icon; color: string }> = {
  term: { icon: Terminal, color: "#7aab6e" },
  browser: { icon: Browser, color: "#5c9bcf" },
  graph: { icon: ChartLineUp, color: "#c8a35a" },
  note: { icon: Note, color: "#8a7aab" },
  code: { icon: Code, color: "#7a8aab" },
  image: { icon: Image, color: "#c07a6e" },
};

function TileEntryRow({
  entry,
  focused,
  nested,
  hasNotif,
  isRenaming,
  renameValue,
  onClick,
  onDoubleClick,
  onContextMenu,
  onRenameChange,
  onRenameConfirm,
  onRenameCancel,
}: {
  entry: TileEntry;
  focused: boolean;
  nested?: boolean;
  hasNotif?: boolean;
  isRenaming: boolean;
  renameValue: string;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameChange: (value: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.select();
    }
  }, [isRenaming]);

  return (
    <div
      className={`tile-entry${focused ? " focused" : ""}${nested ? " nested" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="tile-icon">
        {(() => {
          const def = TYPE_ICONS[entry.type];
          const IconComp = def?.icon ?? Terminal;
          const color = def?.color ?? "#7a8aab";
          return <IconComp size={14} weight="regular" style={{ color }} />;
        })()}
      </div>
      {isRenaming ? (
        <input
          ref={inputRef}
          className="tile-rename-input"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRenameConfirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onRenameCancel();
            }
          }}
          onBlur={onRenameConfirm}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="tile-title">{entry.title}</div>
      )}
      {!isRenaming && hasNotif && <span className="notif-dot" />}
    </div>
  );
}

function App() {
  const [entries, setEntries] = useState<TileEntry[]>([]);
  const [frames, setFrames] = useState<FrameEntry[]>([]);
  const [notif, setNotif] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    const cleanup = window.api.onTileListMessage(
      (channel: string, ...args: unknown[]) => {
        if (channel === "tile-list:frames") {
          const list = Array.isArray(args[0])
            ? args[0].filter(isFrameEntry)
            : [];
          setFrames(list);
        } else if (channel === "tile-list:notif") {
          const ids = Array.isArray(args[0])
            ? args[0].filter((v): v is string => typeof v === "string")
            : [];
          setNotif(new Set(ids));
        } else if (channel === "tile-list:init") {
          const tiles = Array.isArray(args[0])
            ? args[0].filter(isTileEntry)
            : [];
          setEntries(tiles);
        } else if (channel === "tile-list:add") {
          const tile = args[0];
          if (!isTileEntry(tile)) return;
          setEntries((prev) => [
            ...prev.filter((e) => e.id !== tile.id),
            tile,
          ]);
        } else if (channel === "tile-list:remove") {
          const id = args[0] as string;
          setEntries((prev) => prev.filter((e) => e.id !== id));
        } else if (channel === "tile-list:update") {
          const tile = args[0];
          if (!isTileEntry(tile)) return;
          setEntries((prev) =>
            prev.map((e) => (e.id === tile.id ? tile : e)),
          );
        } else if (channel === "tile-list:focus") {
          setFocusedId(args[0] as string | null);
        }
      },
    );

    return () => {
      cleanup();
    };
  }, []);

  const handleClick = useCallback((id: string) => {
    setFocusedId(id);
    window.api.sendToHost("tile-list:peek-tile", id);
  }, []);

  const handleDoubleClick = useCallback((id: string) => {
    setFocusedId(id);
    window.api.sendToHost("tile-list:focus-tile", id);
  }, []);

  const handleContextMenu = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      const selected = await window.api.showContextMenu([
        { id: "rename", label: "Rename" },
      ]);
      if (selected === "rename") {
        const entry = entries.find((en) => en.id === id);
        if (entry) {
          setRenameValue(entry.title);
          setRenamingId(id);
        }
      }
    },
    [entries],
  );

  const commitRename = useCallback(
    (id: string) => {
      const trimmed = renameValue.trim();
      window.api.sendToHost("tile-list:rename-tile", id, trimmed);
      setRenamingId(null);
      setRenameValue("");
    },
    [renameValue],
  );

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue("");
  }, []);

  const gotoFrame = useCallback((id: string) => {
    window.api.sendToHost("tile-list:goto-frame", id);
  }, []);

  const toggleFrame = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { byFrame, looseTiles } = useMemo(() => {
    const frameIds = new Set(frames.map((f) => f.id));
    const map = new Map<string, TileEntry[]>();
    const loose: TileEntry[] = [];
    for (const e of entries) {
      if (e.frameId && frameIds.has(e.frameId)) {
        const arr = map.get(e.frameId);
        if (arr) arr.push(e);
        else map.set(e.frameId, [e]);
      } else {
        loose.push(e);
      }
    }
    return { byFrame: map, looseTiles: loose };
  }, [entries, frames]);

  const visibleTileIds = useMemo(() => {
    const ids: string[] = [];
    for (const f of frames) {
      if (collapsed.has(f.id)) continue;
      for (const e of byFrame.get(f.id) ?? []) ids.push(e.id);
    }
    for (const e of looseTiles) ids.push(e.id);
    return ids;
  }, [frames, byFrame, looseTiles, collapsed]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (renamingId) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (visibleTileIds.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const currentIdx = visibleTileIds.indexOf(focusedId ?? "");
      const nextIdx =
        currentIdx < 0
          ? 0
          : (currentIdx + dir + visibleTileIds.length) % visibleTileIds.length;
      const nextId = visibleTileIds[nextIdx];
      if (nextId) handleClick(nextId);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visibleTileIds, focusedId, handleClick, renamingId]);

  const renderRow = (entry: TileEntry, nested: boolean) => (
    <TileEntryRow
      key={entry.id}
      entry={entry}
      nested={nested}
      hasNotif={notif.has(entry.id)}
      focused={entry.id === focusedId}
      isRenaming={entry.id === renamingId}
      renameValue={entry.id === renamingId ? renameValue : ""}
      onClick={() => handleClick(entry.id)}
      onDoubleClick={() => handleDoubleClick(entry.id)}
      onContextMenu={(e) => handleContextMenu(entry.id, e)}
      onRenameChange={setRenameValue}
      onRenameConfirm={() => commitRename(entry.id)}
      onRenameCancel={cancelRename}
    />
  );

  return (
    <div className="tile-list">
      {frames.map((frame) => {
        const children = byFrame.get(frame.id) ?? [];
        const isCollapsed = collapsed.has(frame.id);
        const frameNotif = children.some((c) => notif.has(c.id));
        return (
          <div key={frame.id} className="frame-group">
            <div
              className="frame-row"
              onClick={() => toggleFrame(frame.id)}
            >
              <CaretRight
                className={`frame-caret${isCollapsed ? "" : " open"}`}
                size={12}
                weight="bold"
              />
              <span
                className="frame-swatch"
                style={{ background: frame.color }}
              />
              <span className="frame-name">{frame.title}</span>
              {frameNotif && <span className="notif-dot" />}
              <span className="frame-count">{children.length}</span>
              <button
                type="button"
                className="frame-goto"
                title="Go to frame"
                onClick={(e) => {
                  e.stopPropagation();
                  gotoFrame(frame.id);
                }}
              >
                <Crosshair size={13} weight="bold" />
              </button>
            </div>
            {!isCollapsed && children.map((entry) => renderRow(entry, true))}
          </div>
        );
      })}
      {looseTiles.map((entry) => renderRow(entry, false))}
      {entries.length === 0 && frames.length === 0 && (
        <div className="tile-empty">
          No tiles on canvas
        </div>
      )}
    </div>
  );
}

export default App;
