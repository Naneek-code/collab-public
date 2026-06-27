import React, { useState } from "react";
import { GitBranch, Plus, Minus, ArrowUUpLeft } from "@phosphor-icons/react";
import "./GitChangesPanel.css";

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

interface GitChangesPanelProps {
  workspacePaths: string[];
  gitStatusData: Record<string, GitStatusData>;
  onRefresh: () => void;
}

export function GitChangesPanel({
  workspacePaths,
  gitStatusData,
  onRefresh,
}: GitChangesPanelProps) {
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const handleCommit = async (wsPath: string) => {
    const msg = commitMessages[wsPath] ?? "";
    if (!msg.trim()) return;

    setBusy((prev) => ({ ...prev, [wsPath]: true }));
    try {
      const data = gitStatusData[wsPath];
      const staged = (data?.files ?? []).filter(
        (f) => f.index !== " " && f.index !== "?"
      );
      // Stage all if none staged
      if (staged.length === 0) {
        await window.api.editorGitStageAll(wsPath);
      }
      const res = await window.api.editorGitCommit(wsPath, msg);
      if (res.ok) {
        setCommitMessages((prev) => ({ ...prev, [wsPath]: "" }));
        onRefresh();
      } else {
        alert(res.error ?? "Commit failed");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setBusy((prev) => ({ ...prev, [wsPath]: false }));
    }
  };

  const handleAction = async (
    e: React.MouseEvent,
    fn: () => Promise<any>
  ) => {
    e.stopPropagation();
    await fn();
    onRefresh();
  };

  const displayBasename = (path: string) => {
    return path.split(/[\\/]/).pop() || path;
  };

  return (
    <div className="git-changes-panel scrollbar-hover">
      {workspacePaths.map((wsPath) => {
        const data = gitStatusData[wsPath];
        if (!data) return null;

        if (!data.isRepo) {
          return (
            <div key={wsPath} className="git-ws-group not-repo">
              <div className="git-ws-header">{displayBasename(wsPath)}</div>
              <div className="git-ws-empty">Not a git repository.</div>
            </div>
          );
        }

        const staged = data.files.filter((f) => f.index !== " " && f.index !== "?");
        const changes = data.files.filter((f) => f.worktree !== " ");
        const sep = wsPath.includes("\\") ? "\\" : "/";

        const handleRowClick = (file: GitFile) => {
          const absPath = `${wsPath}${sep}${file.path.replace(/\//g, sep)}`;
          // Open directly in Diff mode!
          window.api.selectFile(absPath, true);
        };

        return (
          <div key={wsPath} className="git-ws-group">
            <div className="git-ws-header">
              <GitBranch size={14} className="git-ws-icon" />
              <span className="git-ws-name">{displayBasename(wsPath)}</span>
              <span className="git-ws-branch">({data.branch})</span>
            </div>

            {staged.length > 0 && (
              <div className="git-section">
                <div className="git-section-title">
                  <span>Staged Changes ({staged.length})</span>
                  <div className="git-section-actions">
                    <button
                      type="button"
                      data-tooltip="Unstage all files"
                      onClick={(e) =>
                        handleAction(e, () =>
                          window.api.editorGitUnstageAll(wsPath)
                        )
                      }
                    >
                      <Minus size={10} weight="bold" />
                    </button>
                  </div>
                </div>
                {staged.map((file) => (
                  <div
                    key={file.path}
                    className="git-file-row"
                    onClick={() => handleRowClick(file)}
                  >
                    <span className="git-file-name" data-tooltip={file.path}>
                      {file.path.split("/").pop()}
                    </span>
                    <span className="git-file-path">{file.path}</span>
                    <span className="git-row-actions">
                      <button
                        type="button"
                        data-tooltip="Unstage file"
                        onClick={(e) =>
                          handleAction(e, () =>
                            window.api.editorGitUnstage(wsPath, file.path)
                          )
                        }
                      >
                        <Minus size={10} weight="bold" />
                      </button>
                    </span>
                    <span className="git-status-char index-stage">{file.index}</span>
                  </div>
                ))}
              </div>
            )}

            {changes.length > 0 && (
              <div className="git-section">
                <div className="git-section-title">
                  <span>Changes ({changes.length})</span>
                  <div className="git-section-actions">
                    <button
                      type="button"
                      data-tooltip="Discard all changes"
                      onClick={(e) => {
                        if (!confirm("Discard all unstaged changes? This action cannot be undone.")) return;
                        void handleAction(e, () =>
                          window.api.editorGitDiscardAll(wsPath)
                        );
                      }}
                    >
                      <ArrowUUpLeft size={10} weight="bold" />
                    </button>
                    <button
                      type="button"
                      data-tooltip="Stage all changes"
                      onClick={(e) =>
                        handleAction(e, () =>
                          window.api.editorGitStageAll(wsPath)
                        )
                      }
                    >
                      <Plus size={10} weight="bold" />
                    </button>
                  </div>
                </div>
                {changes.map((file) => (
                  <div
                    key={file.path}
                    className="git-file-row"
                    onClick={() => handleRowClick(file)}
                  >
                    <span className="git-file-name" data-tooltip={file.path}>
                      {file.path.split("/").pop()}
                    </span>
                    <span className="git-file-path">{file.path}</span>
                    <span className="git-row-actions">
                      <button
                        type="button"
                        data-tooltip="Discard changes"
                        onClick={(e) => {
                          if (!confirm(`Discard changes in ${file.path}?`)) return;
                          void handleAction(e, () =>
                            window.api.editorGitDiscard(wsPath, file.path)
                          );
                        }}
                      >
                        <ArrowUUpLeft size={10} weight="bold" />
                      </button>
                      <button
                        type="button"
                        data-tooltip="Stage changes"
                        onClick={(e) =>
                          handleAction(e, () =>
                            window.api.editorGitStage(wsPath, file.path)
                          )
                        }
                      >
                        <Plus size={10} weight="bold" />
                      </button>
                    </span>
                    <span className={`git-status-char worktree-${file.worktree === "?" ? "untracked" : "modified"}`}>
                      {file.worktree === "?" ? "U" : file.worktree}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {staged.length === 0 && changes.length === 0 && (
              <div className="git-ws-empty">No changes in workspace.</div>
            )}

            <div className="git-commit-box">
              <input
                type="text"
                placeholder="Commit message..."
                value={commitMessages[wsPath] ?? ""}
                onChange={(e) =>
                  setCommitMessages((prev) => ({
                    ...prev,
                    [wsPath]: e.target.value,
                  }))
                }
                disabled={busy[wsPath]}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCommit(wsPath);
                }}
              />
              <button
                type="button"
                onClick={() => handleCommit(wsPath)}
                disabled={busy[wsPath] || !(commitMessages[wsPath] ?? "").trim()}
              >
                {busy[wsPath] ? "Committing..." : "Commit"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
