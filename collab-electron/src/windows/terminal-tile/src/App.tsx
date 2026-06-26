import { useEffect, useState } from "react";
import { TerminalTab } from "@collab/components/Terminal";

/** Approximate terminal dimensions from the viewport before xterm mounts. */
function estimateTermSize(): { cols: number; rows: number } {
  const CHAR_WIDTH = 7.2; // Hack 12px approximate
  const CELL_HEIGHT = 17; // xterm line height at fontSize 12
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  return {
    cols: Math.max(80, Math.floor(w / CHAR_WIDTH)),
    rows: Math.max(24, Math.floor(h / CELL_HEIGHT)),
  };
}

function App() {
  const [sessionId, setSessionId] = useState<string | null>(
    null,
  );
  const [exited, setExited] = useState(false);
  const [restored, setRestored] = useState(false);
  const [scrollbackData, setScrollbackData] =
    useState<string | null>(null);
  const [sessionMode, setSessionMode] =
    useState<"tmux" | "sidecar" | undefined>(undefined);

  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search,
    );
    const existingSessionId = params.get("sessionId");
    const isRestored = params.get("restored") === "1";
    const cwd = params.get("cwd") || undefined;
    const tileId = params.get("tileId") || undefined;
    const urlTarget = params.get("target") || undefined;

    let cancelled = false;

    // After a reboot the original shell process is gone, but if an AI agent
    // (Claude Code / Codex) was running here its session was recorded. Replay
    // the resume command into the fresh shell to restore the agent context.
    const injectResume = (
      newSessionId: string,
      binding: { agentSessionId: string; agentKind: string } | null,
    ) => {
      if (!binding?.agentSessionId) return;
      const cmd =
        binding.agentKind === "codex"
          ? `codex resume ${binding.agentSessionId}`
          : `claude --resume ${binding.agentSessionId}`;
      // Wait for the shell to print its prompt before typing, otherwise the
      // command is swallowed while the profile is still loading.
      let sent = false;
      const send = () => {
        if (sent || cancelled) return;
        sent = true;
        window.api.offPtyData(newSessionId, onData);
        window.api.ptyWrite(newSessionId, `${cmd}\r`);
      };
      const onData = () => {
        window.api.offPtyData(newSessionId, onData);
        setTimeout(send, 600);
      };
      window.api.onPtyData(newSessionId, onData);
      setTimeout(send, 5000);
    };

    const createFreshSession = (
      target?: string,
      nextCwd?: string,
      binding?: {
        agentSessionId: string;
        agentKind: string;
        cwd: string | null;
      } | null,
    ) => {
      const est = estimateTermSize();
      const useCwd = binding?.cwd ?? nextCwd ?? cwd;
      window.api
        .ptyCreate(useCwd, est.cols, est.rows, target, tileId)
        .then((result) => {
          if (cancelled) return;
          setSessionId(result.sessionId);
          window.api.notifyPtySessionId(
            result.sessionId,
          );
          // If the requested cwd no longer existed, the main process
          // opened the shell in the nearest existing parent. Report that
          // corrected cwd so it becomes the default for subsequent
          // terminals and the fallback notice doesn't recur.
          if (
            useCwd
            && result.cwdHostPath
            && result.cwdHostPath !== useCwd
          ) {
            window.api.notifyCwdChanged(
              result.sessionId,
              result.cwdHostPath,
            );
          }
          if (binding) injectResume(result.sessionId, binding);
        })
        .catch(() => {
          if (!cancelled) setExited(true);
        });
    };

    const init = async () => {
      const binding = tileId
        ? await window.api.agentResumeGet(tileId).catch(() => null)
        : null;

      if (isRestored && existingSessionId) {
        setRestored(true);
        const { cols, rows } = estimateTermSize();
        try {
          const sessions = await window.api.ptyDiscover();
          const found = sessions.some(
            (session) => session.sessionId === existingSessionId,
          );
          if (!found) throw new Error("Missing restored session");
          const result = await window.api.ptyReconnect(
            existingSessionId,
            cols,
            rows,
          );
          if (cancelled) return;
          if (result.scrollback) setScrollbackData(result.scrollback);
          if (result.mode) setSessionMode(result.mode);
          setSessionId(existingSessionId);
          // Reconnect succeeded — the agent (if any) is still alive, so we
          // must NOT re-inject a resume command.
        } catch {
          if (cancelled) return;
          setRestored(false);
          // Recover the original working directory so the fallback session
          // opens in the right place (also required for agent resume).
          let fallbackCwd = binding?.cwd ?? cwd;
          let fallbackTarget: string | undefined;
          if (existingSessionId) {
            try {
              const meta = await window.api.ptyReadMeta(
                existingSessionId,
              );
              if (!fallbackCwd && meta?.cwd) fallbackCwd = meta.cwd;
              if (meta?.target) fallbackTarget = meta.target;
            } catch {
              // Metadata unavailable — fall through to default
            }
          }
          createFreshSession(fallbackTarget, fallbackCwd, binding);
        }
        return;
      }

      if (existingSessionId) {
        setSessionId(existingSessionId);
        return;
      }

      createFreshSession(urlTarget, undefined, binding);
    };

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const handleExit = (payload: {
      sessionId: string;
      exitCode: number;
    }) => {
      if (payload.sessionId === sessionId) {
        setExited(true);
      }
    };
    window.api.onPtyExit(sessionId, handleExit);
    return () => window.api.offPtyExit(sessionId, handleExit);
  }, [sessionId]);

  if (exited) {
    return (
      <div className="terminal-tile-exited">
        Session ended
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="terminal-tile-loading">
        Connecting...
      </div>
    );
  }

  return (
    <TerminalTab
      sessionId={sessionId}
      visible={true}
      restored={restored}
      scrollbackData={scrollbackData}
      mode={sessionMode}
    />
  );
}

export default App;
