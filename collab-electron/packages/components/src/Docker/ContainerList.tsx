import { useCallback, useEffect, useRef, useState } from "react";
import "./ContainerList.css";

interface Container {
  id: string;
  shortId: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  running: boolean;
}

type Action = "start" | "stop" | "restart";

interface Props {
  /**
   * "tile" renders a full panel header (for the canvas tile); "panel" is the
   * compact variant embedded in the navigator sidebar.
   */
  variant?: "tile" | "panel";
}

const POLL_MS = 3000;

function RefreshIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 3v4h-4" />
      <path d="M12.36 10a5 5 0 1 1-.96-5.36L13 7" />
    </svg>
  );
}

export function ContainerList({ variant = "tile" }: Props) {
  const [containers, setContainers] = useState<Container[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const api = window.api;
    if (!api?.dockerList) return;
    try {
      const [list, avail] = await Promise.all([
        api.dockerList(),
        api.dockerAvailable(),
      ]);
      if (!mounted.current) return;
      setAvailable(avail.available);
      setError(avail.available ? null : avail.error ?? "Docker is not running");
      setContainers(avail.available ? (list as Container[]) : []);
    } catch (err) {
      if (!mounted.current) return;
      setAvailable(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (id: string, action: Action) => {
      const api = window.api;
      setBusy((b) => ({ ...b, [id]: true }));
      try {
        const fn =
          action === "start"
            ? api.dockerStart
            : action === "stop"
              ? api.dockerStop
              : api.dockerRestart;
        const result = await fn(id);
        if (!result.ok && result.error) {
          setError(result.error);
        }
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[id];
          return next;
        });
        void refresh();
      }
    },
    [refresh],
  );

  const runningCount = containers.filter((c) => c.running).length;

  return (
    <div className={`docker-list docker-list--${variant}`}>
      <div className="docker-list-header">
        <span className="docker-list-title">
          Containers
          {available && containers.length > 0 && (
            <span className="docker-list-count">
              {runningCount}/{containers.length}
            </span>
          )}
        </span>
        <button
          type="button"
          className="docker-icon-btn"
          title="Refresh"
          onClick={() => void refresh()}
        >
          <RefreshIcon />
        </button>
      </div>

      {loading && available === null && (
        <div className="docker-list-empty">Loading…</div>
      )}

      {available === false && (
        <div className="docker-list-empty docker-list-error">
          {error || "Docker is not available."}
          <div className="docker-list-hint">
            Make sure Docker is installed and the daemon is running.
          </div>
        </div>
      )}

      {available === true && containers.length === 0 && (
        <div className="docker-list-empty">No containers found.</div>
      )}

      {available === true && containers.length > 0 && (
        <ul className="docker-list-items">
          {containers.map((c) => (
            <li key={c.id} className="docker-item">
              <div className="docker-item-main">
                <span
                  className={`docker-dot ${
                    c.running ? "docker-dot--up" : "docker-dot--down"
                  }`}
                  title={c.state}
                />
                <div className="docker-item-text">
                  <span className="docker-item-name" title={c.name}>
                    {c.name || c.shortId}
                  </span>
                  <span className="docker-item-sub" title={c.image}>
                    {c.image}
                  </span>
                  <span className="docker-item-status">{c.status}</span>
                </div>
              </div>
              <div className="docker-item-actions">
                <button
                  type="button"
                  className="docker-action"
                  title="Open terminal in container"
                  disabled={!c.running || busy[c.id]}
                  onClick={() =>
                    window.api.dockerOpenTerminal(c.id, c.name || c.shortId)
                  }
                >
                  Terminal
                </button>
                <button
                  type="button"
                  className="docker-action"
                  title="Stream container logs"
                  disabled={busy[c.id]}
                  onClick={() =>
                    window.api.dockerOpenLogs(c.id, c.name || c.shortId)
                  }
                >
                  Logs
                </button>
                {c.running ? (
                  <>
                    <button
                      type="button"
                      className="docker-action"
                      title="Restart container"
                      disabled={busy[c.id]}
                      onClick={() => void runAction(c.id, "restart")}
                    >
                      Restart
                    </button>
                    <button
                      type="button"
                      className="docker-action docker-action--danger"
                      title="Stop container"
                      disabled={busy[c.id]}
                      onClick={() => void runAction(c.id, "stop")}
                    >
                      Stop
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="docker-action docker-action--primary"
                    title="Start container"
                    disabled={busy[c.id]}
                    onClick={() => void runAction(c.id, "start")}
                  >
                    Start
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
