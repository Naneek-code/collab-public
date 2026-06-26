import { useEffect, useState } from "react";
import { ContainerList } from "@collab/components/Docker";
import "./DockerSection.css";

/**
 * Collapsible "Containers" section pinned to the bottom of the navigator.
 * Hidden entirely until Docker is detected so non-Docker users see nothing.
 */
export function DockerSection() {
  const [open, setOpen] = useState(false);
  const [hasDocker, setHasDocker] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      window.api
        ?.dockerAvailable?.()
        .then((res) => {
          if (!cancelled) setHasDocker(res.available);
        })
        .catch(() => {
          if (!cancelled) setHasDocker(false);
        });
    };
    probe();
    // Docker Desktop may start after the app; re-probe periodically while hidden.
    const interval = setInterval(probe, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!hasDocker) return null;

  return (
    <div className="docker-section">
      <div className="docker-section-bar">
        <button
          type="button"
          className="docker-section-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={`docker-section-caret ${
              open ? "docker-section-caret--open" : ""
            }`}
          >
            ▸
          </span>
          Containers
        </button>
        <button
          type="button"
          className="docker-section-open-tile"
          title="Open containers panel on canvas"
          onClick={() => window.api.dockerOpenPanel()}
        >
          ⤢
        </button>
      </div>
      {open && (
        <div className="docker-section-body">
          <ContainerList variant="panel" />
        </div>
      )}
    </div>
  );
}
