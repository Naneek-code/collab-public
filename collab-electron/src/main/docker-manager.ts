import { execFile } from "node:child_process";

/**
 * Thin wrapper around the `docker` CLI. We shell out to the binary rather than
 * talk to the daemon socket directly so the same code path works across the
 * Docker Desktop / Engine / WSL2 variations our users run, with no extra deps.
 */

export interface DockerContainer {
  /** Full container ID (not truncated). */
  id: string;
  /** Short 12-char ID for display. */
  shortId: string;
  /** Primary container name (leading slash stripped). */
  name: string;
  image: string;
  /** Lifecycle state: running | exited | created | paused | restarting | dead. */
  state: string;
  /** Human-readable status, e.g. "Up 3 minutes". */
  status: string;
  /** Raw port mapping string from `docker ps`. */
  ports: string;
  running: boolean;
}

export interface DockerAvailability {
  available: boolean;
  /** Reason it is unavailable (binary missing, daemon down, etc.). */
  error?: string;
}

const CLI_TIMEOUT_MS = 8000;

function dockerCli(
  args: string[],
  timeout = CLI_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const message = (stderr || err.message || "").trim();
          reject(new Error(message || "docker command failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Shape of one line of `docker ps --format "{{json .}}"`. */
interface DockerPsJson {
  ID?: string;
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: string;
}

function normalizeContainer(raw: DockerPsJson): DockerContainer {
  const id = raw.ID ?? "";
  const name = (raw.Names ?? "").split(",")[0]?.replace(/^\//, "") ?? "";
  const state = (raw.State ?? "").toLowerCase();
  return {
    id,
    shortId: id.slice(0, 12),
    name,
    image: raw.Image ?? "",
    state,
    status: raw.Status ?? "",
    ports: raw.Ports ?? "",
    running: state === "running",
  };
}

/**
 * List all containers (running and stopped). Each line of output is a self
 * contained JSON object, so we parse line-by-line rather than the whole blob.
 */
export async function listContainers(): Promise<DockerContainer[]> {
  const out = await dockerCli([
    "ps",
    "-a",
    "--no-trunc",
    "--format",
    "{{json .}}",
  ]);
  const containers: DockerContainer[] = [];
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      containers.push(normalizeContainer(JSON.parse(trimmed) as DockerPsJson));
    } catch {
      // Skip malformed lines rather than failing the whole listing.
    }
  }
  // Running first, then by name for a stable, readable ordering.
  containers.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return containers;
}

export async function checkAvailability(): Promise<DockerAvailability> {
  try {
    // `docker ps` exercises both the binary and a live daemon connection.
    await dockerCli(["ps", "--format", "{{.ID}}"], 5000);
    return { available: true };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function startContainer(id: string): Promise<void> {
  await dockerCli(["start", id]);
}

export async function stopContainer(id: string): Promise<void> {
  // Stops have a built-in 10s grace period before SIGKILL; give the CLI room.
  await dockerCli(["stop", id], 20000);
}

export async function restartContainer(id: string): Promise<void> {
  await dockerCli(["restart", id], 25000);
}
