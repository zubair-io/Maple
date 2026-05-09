/**
 * Stage child supervisor.
 *
 * Generalizes src/api/src/indexer/control.ts to manage N named stage children.
 * In Plan 1 the stage list is empty by default; Plans 2–3 populate it by
 * calling addStage() as each stage is cut over.
 *
 * Each child runs as:
 *   bun run src/api/src/workers/runtime/main.ts <stageName>
 *
 * IPC uses a small per-child HTTP server on localhost (a random high port
 * assigned by the OS and signalled via stdout __MAPLE_IPC_PORT__=<port>).
 * The supervisor sends pause/resume/reload-config over plain fetch().
 *
 * Crash backoff: 1s, 2s, 4s, 8s, 16s, saturates at 30s.
 * After 5 consecutive crashes, the stage is marked `status: "error"` and
 * stays down until POST /api/workers/:name/retry-dead is called.
 *
 * Config changes:
 *   PATCH /api/workers/:name/config
 *     → writes to Mongo (persistence)
 *     → calls supervisor.notifyConfigChanged(name)
 *     → supervisor POSTs reload-config to child's IPC port
 *     → child re-reads worker_config[name] from Mongo and applies live
 */

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
const MAX_CONSECUTIVE_CRASHES = 5;
const HEALTHY_RESET_MS = 60_000;
const STOP_GRACE_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;

export type StageStatus =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "error";

export interface StageProcessState {
  status: StageStatus;
  pid: number | null;
  lastStartedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  restartCount: number;
  /** Latest throughput value (completions per minute over rolling 5m). */
  throughput: number;
  /** Number of in-flight docs at the last IPC poll. */
  inFlight: number;
}

interface ChildHandle {
  pid: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  exited?: Promise<number>;
  ipcPort?: number;
}

interface SupervisorOptions {
  /**
   * Override the script path used when spawning a stage. Test-only.
   * Key is stage name, value is an absolute path to a .ts file.
   */
  _stageScriptOverrides?: Record<string, string>;
  /**
   * Override the backoff sequence in ms. Test-only.
   * Defaults to BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000].
   */
  _backoffMsOverride?: number[];
  readyTimeoutMs?: number;
}

interface ManagedStage {
  name: string;
  state: StageProcessState;
  child: ChildHandle | null;
  consecutiveCrashes: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  healthyResetTimer: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
}

export class Supervisor {
  private stages = new Map<string, ManagedStage>();
  private readonly opts: SupervisorOptions;

  constructor(initialStageNames: string[], opts: SupervisorOptions = {}) {
    this.opts = opts;
    for (const name of initialStageNames) {
      this.addStage(name);
    }
  }

  /** Add a stage and immediately spawn its child. */
  addStage(name: string): void {
    if (this.stages.has(name)) return;
    const managed: ManagedStage = {
      name,
      state: {
        status: "stopped",
        pid: null,
        lastStartedAt: null,
        lastExitCode: null,
        lastError: null,
        restartCount: 0,
        throughput: 0,
        inFlight: 0,
      },
      child: null,
      consecutiveCrashes: 0,
      restartTimer: null,
      healthyResetTimer: null,
      stopRequested: false,
    };
    this.stages.set(name, managed);
    this.spawn(name);
  }

  /** Snapshot of all stage statuses. */
  statuses(): Record<string, StageProcessState> {
    const out: Record<string, StageProcessState> = {};
    for (const [name, m] of this.stages) {
      out[name] = { ...m.state };
    }
    return out;
  }

  private argsFor(name: string): string[] {
    const override = this.opts._stageScriptOverrides?.[name];
    if (override) return [override];
    const dir = (import.meta as { dir?: string }).dir ?? __dirname;
    return [`${dir}/runtime/main.ts`, name];
  }

  private spawn(name: string): void {
    const m = this.stages.get(name);
    if (!m) return;
    if (m.state.status === "starting" || m.state.status === "running") return;

    m.stopRequested = false;
    m.state = {
      ...m.state,
      status: m.consecutiveCrashes > 0 ? "restarting" : "starting",
      lastStartedAt: new Date().toISOString(),
      lastError: null,
    };

    const env = { ...process.env };
    const Bun = (globalThis as unknown as { Bun?: { spawn: (o: unknown) => ChildHandle } }).Bun;

    // Bun is the only supported runtime. The Bun global is always present.
    if (!Bun) {
      throw new Error("supervisor requires Bun runtime");
    }
    const child: ChildHandle = Bun.spawn({
      cmd: ["bun", ...this.argsFor(name)],
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    this.forwardStream(child.stdout as ReadableStream<Uint8Array> | null, process.stdout, `[${name}]`, name);
    this.forwardStream(child.stderr as ReadableStream<Uint8Array> | null, process.stderr, `[${name}]`, name);
    if (child.exited) {
      child.exited.then((code) => this.onExit(name, code)).catch(() => this.onExit(name, -1));
    }

    m.child = child;
    m.state = { ...m.state, pid: child.pid ?? null };

    this.waitReady(name, this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS).catch(
      () => { /* onExit handles the crash case */ },
    );
  }

  private onExit(name: string, code: number): void {
    const m = this.stages.get(name);
    if (!m) return;

    m.state = { ...m.state, pid: null, lastExitCode: code };
    m.child = null;

    if (m.healthyResetTimer) {
      clearTimeout(m.healthyResetTimer);
      m.healthyResetTimer = null;
    }

    if (m.stopRequested) {
      m.state = { ...m.state, status: "stopped", lastError: null };
      return;
    }

    m.consecutiveCrashes++;
    m.state = {
      ...m.state,
      status: "error",
      lastError: `child exited with code ${code}`,
      restartCount: m.state.restartCount + (code !== 0 ? 1 : 0),
    };

    if (m.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      process.stderr.write(
        `[${name}] supervisor: ${m.consecutiveCrashes} consecutive crashes — staying down\n`,
      );
      return;
    }

    const backoffSeq = this.opts._backoffMsOverride ?? BACKOFF_MS;
    const idx = Math.min(m.consecutiveCrashes - 1, backoffSeq.length - 1);
    const delay = backoffSeq[idx];
    process.stderr.write(
      `[${name}] supervisor: crash (${m.consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES}) — retry in ${delay}ms\n`,
    );
    m.state = { ...m.state, status: "restarting" };
    m.restartTimer = setTimeout(async () => {
      m.restartTimer = null;
      this.spawn(name);
      try {
        await this.waitReady(name);
      } catch {
        /* onExit already handles the next crash */
      }
    }, delay);
  }

  private scheduleHealthyReset(name: string): void {
    const m = this.stages.get(name);
    if (!m) return;
    if (m.healthyResetTimer) clearTimeout(m.healthyResetTimer);
    m.healthyResetTimer = setTimeout(() => {
      if (m.state.status === "running") m.consecutiveCrashes = 0;
      m.healthyResetTimer = null;
    }, HEALTHY_RESET_MS);
  }

  private async waitReady(name: string, timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    const m = this.stages.get(name);
    if (!m) throw new Error(`unknown stage: ${name}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (m.state.status === "stopped" || m.state.status === "error") return;
      if (m.state.status === "running") return;

      const port = m.child?.ipcPort;
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/status`, {
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            // Parse the response body and update inFlight/throughput so
            // the API /status route reports live values (Issue 12).
            try {
              const body = await res.json() as { inFlight?: number; throughput?: number };
              m.state = {
                ...m.state,
                status: "running",
                lastError: null,
                inFlight: typeof body.inFlight === "number" ? body.inFlight : m.state.inFlight,
                throughput: typeof body.throughput === "number" ? body.throughput : m.state.throughput,
              };
            } catch {
              m.state = { ...m.state, status: "running", lastError: null };
            }
            this.scheduleHealthyReset(name);
            return;
          }
        } catch {
          /* not ready yet */
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    m.state = {
      ...m.state,
      status: "error",
      lastError: `waitReady timeout after ${timeoutMs}ms`,
    };
  }

  /** Parse ready / IPC-port signals from child stdout lines. */
  private handleReadySignal(name: string, line: string): void {
    // IPC port signal emitted by the child's runStage after IpcServer.start()
    const portMatch = line.match(/^__MAPLE_IPC_PORT__=(\d+)$/);
    if (portMatch) {
      const m = this.stages.get(name);
      if (m?.child) {
        m.child.ipcPort = parseInt(portMatch[1], 10);
        if (m.state.status !== "running") {
          m.state = { ...m.state, status: "running", lastError: null };
          this.scheduleHealthyReset(name);
        }
      }
      return;
    }
    // Fallback ready signal for test scripts that don't start an IPC server
    if (line.includes("__MAPLE_READY__")) {
      const m = this.stages.get(name);
      if (m && m.state.status !== "running") {
        m.state = { ...m.state, status: "running", lastError: null };
        this.scheduleHealthyReset(name);
      }
    }
  }

  private async forwardStream(
    source: ReadableStream<Uint8Array> | null | undefined,
    sink: NodeJS.WriteStream,
    prefix: string,
    stageName: string,
  ): Promise<void> {
    if (!source || typeof (source as ReadableStream).getReader !== "function") return;
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) {
        if (buf.length > 0) {
          sink.write(`${prefix} ${buf}\n`);
          this.handleReadySignal(stageName, buf);
        }
        return;
      }
      if (!chunk.value) continue;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        sink.write(`${prefix} ${line}\n`);
        this.handleReadySignal(stageName, line);
        nl = buf.indexOf("\n");
      }
    }
  }

  private writeLines(s: string, sink: NodeJS.WriteStream, name: string): void {
    for (const line of s.split("\n")) {
      if (line.length > 0) {
        sink.write(`[${name}] ${line}\n`);
        this.handleReadySignal(name, line);
      }
    }
  }

  /** Send a pause command to a named stage child via IPC. */
  async pause(name: string): Promise<{ ok: boolean; error?: string }> {
    const m = this.stages.get(name);
    if (!m) return { ok: false, error: `unknown stage: ${name}` };
    const port = m.child?.ipcPort;
    if (!port) return { ok: false, error: "stage has no IPC port (not running)" };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/pause`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { ok: true } : { ok: false, error: `IPC returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Send a resume command to a named stage child via IPC. */
  async resume(name: string): Promise<{ ok: boolean; error?: string }> {
    const m = this.stages.get(name);
    if (!m) return { ok: false, error: `unknown stage: ${name}` };
    const port = m.child?.ipcPort;
    if (!port) return { ok: false, error: "stage has no IPC port (not running)" };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/resume`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { ok: true } : { ok: false, error: `IPC returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Notify a stage child that its config has changed.
   * Called by the PATCH /api/workers/:name/config handler after writing to Mongo.
   * POSTs reload-config to the child's IPC port; the child re-reads its config
   * from Mongo and applies the new values live (concurrency, pollIntervalMs,
   * batchSize, maxAttempts, paused).
   */
  async notifyConfigChanged(name: string): Promise<{ ok: boolean; error?: string }> {
    const m = this.stages.get(name);
    if (!m) return { ok: false, error: `unknown stage: ${name}` };
    const port = m.child?.ipcPort;
    if (!port) return { ok: false, error: "stage has no IPC port (not running)" };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/reload-config`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { ok: true } : { ok: false, error: `IPC returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stop all stage children gracefully. */
  async stopAll(): Promise<void> {
    for (const [_name, m] of this.stages) {
      m.stopRequested = true;
      if (m.restartTimer) {
        clearTimeout(m.restartTimer);
        m.restartTimer = null;
      }
      if (m.healthyResetTimer) {
        clearTimeout(m.healthyResetTimer);
        m.healthyResetTimer = null;
      }
      const child = m.child;
      if (!child) continue;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const exitedP = child.exited ?? new Promise<number>((resolve) => {
        const start = Date.now();
        const tick = setInterval(() => {
          if (!m.child || Date.now() - start > STOP_GRACE_MS + 1000) {
            clearInterval(tick);
            resolve(-1);
          }
        }, 50);
      });
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), STOP_GRACE_MS));
      const result = await Promise.race([exitedP.then(() => "exited" as const), timeout]);
      if (result === "timeout" && m.child) {
        try {
          m.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      m.state = { ...m.state, status: "stopped", pid: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + convenience helpers (used by index.ts and tests)
// ---------------------------------------------------------------------------

export interface StartSupervisorOptions extends SupervisorOptions {
  /** Stage names to launch immediately. */
  stages: string[];
  /** Optional discover configuration — if provided, startDiscover is called
   *  in-process and the handle is bundled into the returned stop(). */
  discover?: {
    /** Optional folder ObjectId hex. Omit when watching all registered folder
     *  roots without a specific folder association (e.g. startup auto-discover). */
    folderId?: string;
    roots: string[];
  };
}

export interface SupervisorHandle {
  stop: () => Promise<void>;
}

let _singleton: Supervisor | null = null;

/**
 * Start the supervisor with the given stage list.
 * Idempotent — if already running, stops the old instance first.
 */
export async function startSupervisor(opts: StartSupervisorOptions): Promise<SupervisorHandle> {
  if (_singleton) {
    await _singleton.stopAll();
    _singleton = null;
  }

  const { stages, discover, ...supervisorOpts } = opts;
  const sup = new Supervisor(stages, supervisorOpts);
  _singleton = sup;

  let discoverHandle: { stop: () => Promise<void> } | null = null;
  if (discover && discover.roots.length > 0) {
    const { startDiscover } = await import("./discover/index.ts");
    discoverHandle = await startDiscover({
      folderId: discover.folderId ?? "",
      roots: discover.roots,
    });
  }

  return {
    stop: async () => {
      if (discoverHandle) await discoverHandle.stop();
      await sup.stopAll();
      if (_singleton === sup) _singleton = null;
    },
  };
}

/** Stop the running supervisor singleton (no-op if not running). */
export async function stopSupervisor(): Promise<void> {
  if (_singleton) {
    await _singleton.stopAll();
    _singleton = null;
  }
}

/** Snapshot of current supervisor stage statuses. */
export function supervisorState(): Record<string, StageProcessState> {
  if (!_singleton) return {};
  return _singleton.statuses();
}

/** Pause a stage by name. */
export async function pauseSupervisor(name?: string): Promise<void> {
  if (!_singleton) return;
  if (name) {
    await _singleton.pause(name);
  } else {
    // Pause all stages
    for (const stageName of Object.keys(_singleton.statuses())) {
      await _singleton.pause(stageName);
    }
  }
}

/** Resume a stage by name. */
export async function resumeSupervisor(name?: string): Promise<void> {
  if (!_singleton) return;
  if (name) {
    await _singleton.resume(name);
  } else {
    // Resume all stages
    for (const stageName of Object.keys(_singleton.statuses())) {
      await _singleton.resume(stageName);
    }
  }
}
