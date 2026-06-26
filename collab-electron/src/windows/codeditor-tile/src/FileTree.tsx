import { useEffect, useState } from "react";
import { ChevronRight, File, Folder } from "lucide-react";

interface Entry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function joinPath(parent: string, name: string, sep: string): string {
  return parent.endsWith(sep) ? parent + name : parent + sep + name;
}

interface NodeProps {
  path: string;
  name: string;
  isDir: boolean;
  sep: string;
  depth: number;
  activePath: string | null;
  onOpen: (path: string, name: string) => void;
}

function TreeNode({ path, name, isDir, sep, depth, activePath, onOpen }: NodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);

  const toggle = () => {
    if (!isDir) {
      onOpen(path, name);
      return;
    }
    if (!open && children === null) {
      window.api
        .readDir(path)
        .then((es: Entry[]) => setChildren(sortEntries(es)))
        .catch(() => setChildren([]));
    }
    setOpen((v) => !v);
  };

  return (
    <div>
      <div
        className={`vsc-row${activePath === path ? " active" : ""}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={toggle}
        title={name}
      >
        {isDir ? (
          <ChevronRight
            size={14}
            className={`vsc-caret${open ? " open" : ""}`}
          />
        ) : (
          <span className="vsc-caret-spacer" />
        )}
        {isDir ? (
          <Folder size={14} className="vsc-row-icon vsc-folder-icon" />
        ) : (
          <File size={14} className="vsc-row-icon" />
        )}
        <span className="vsc-row-label">{name}</span>
      </div>
      {isDir && open && children && (
        <div>
          {children.map((c) => (
            <TreeNode
              key={c.name}
              path={joinPath(path, c.name, sep)}
              name={c.name}
              isDir={c.isDirectory}
              sep={sep}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FileTreeProps {
  root: string;
  activePath: string | null;
  onOpen: (path: string, name: string) => void;
}

export function FileTree({ root, activePath, onOpen }: FileTreeProps) {
  const sep = root.includes("\\") ? "\\" : "/";
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .readDir(root)
      .then((es: Entry[]) => {
        if (!cancelled) setEntries(sortEntries(es));
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  if (!entries) return <div className="vsc-tree-loading">Loading…</div>;
  if (entries.length === 0) {
    return <div className="vsc-tree-loading">Empty folder</div>;
  }

  return (
    <div className="vsc-tree">
      {entries.map((c) => (
        <TreeNode
          key={c.name}
          path={joinPath(root, c.name, sep)}
          name={c.name}
          isDir={c.isDirectory}
          sep={sep}
          depth={0}
          activePath={activePath}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
