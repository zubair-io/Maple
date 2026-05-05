/**
 * Child-process supervisor for the standalone indexer.
 *
 * The parent HTTP server (`src/index.ts`) runs on a dedicated event loop and
 * proxies `/api/indexer/*` to the child. The child is spawned via
 * `bun src/api/src/indexer/standalone.ts` and listens on
 * `MAPLE_INDEXER_PORT` (default 3100, 127.0.0.1 only).
 *
 * Responsibilities:
 *   - Spawn / re-spawn the child with `Bun.spawn`
 *   - Pipe its stdout/stderr through with a `[indexer]` prefix
 *   - Send SIGTERM (graceful) or SIGKILL (forced) on stop
 *   - Auto-respawn on crash with exponential backoff (1s, 2s, 4s, 8s, max 30s)
 *   - Reset backoff after 60s of healthy uptime
 *   - Cap consecutive crashes at 5; afterwards stay `crashed` until manual start
 *   - `waitReady()` — poll `/status` until 200 (10s timeout)
 */

import { spawn as nodeSpawn } from "node:child_process";

const DEFAULT_PORT = 3100;

/** Supervisor + indexer-process status snapshot. */
export interface IndexerProcessState {
  status: "stopped" | "starting" | "running" | "crashed" | "restarting";
  pid: number | null;
  lastStartedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  restartCount: number;
}

/** Backoff sequence in ms; saturates at 30 000. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const HEALTHY_RESET_MS = 60_000;
const MAX_CONSECUTIVE_CRASHES = 5;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_INTERVAL_MS = 200;
const STOP_GRACE_MS = 10_000;

interface ChildHandle {
  // Bun's spawn returns a Subprocess; we only use the bits compatible with
  // node's ChildProcess so the type is intentionally narrow.
  pid: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  exited?: Promise<number>; // Bun-only convenience
  stdout?: ReadableStream<Uint8Array> | { pipe?: unknown } | null;
  stderr?: ReadableStream<Uint8Array> | { pipe?: unknown } | null;
  on?: (ev: string, fn: (...args: unknown[]) => void) => void;
}

let _state: IndexerProcessState = {
  status: "stopped",
  pid: null,
  lastStartedAt: null,
  lastExitCode: null,
  lastError: null,
  restartCount: 0,
};

let _child: ChildHandle | null = null;
let _consecutiveCrashes = 0;
let _restartTimer: ReturnType<typeof setTimeout> | null = null;
let _healthyResetTimer: ReturnType<typeof setTimeout> | null = null;
let _stopRequested = false;

/** Internal — read the current child port. */
function port(): number {
  return Number(process.env.MAPLE_INDEXER_PORT ?? DEFAULT_PORT);
}

/** Build a URL pointing at the child's localhost-only port. */
export function targetUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://127.0.0.1:${port()}${p}`;
}

/** Live snapshot of supervisor state (cloned so callers can't mutate). */
export function state(): IndexerProcessState {
  return { ..._state };
}

/** Used by tests to reset the singleton. */
export function _resetForTests(): void {
  if (_restartTimer) clearTimeout(_restartTimer);
  if (_healthyResetTimer) clearTimeout(_healthyResetTimer);
  _restartTimer = null;
  _healthyResetTimer = null;
  _child = null;
  _consecutiveCrashes = 0;
  _stopRequested = false;
  _state = {
    status: "stopped",
    pid: null,
    lastStartedAt: null,
    lastExitCode: null,
    lastError: null,
    restartCount: 0,
  };
}

/**
 * Test-only — drive the supervisor into a specific status without
 * actually spawning a child. Lets the proxy tests assert behaviour
 * around `running` vs `stopped` without the cost of forking a real
 * child process.
 */
export function _setStatusForTests(status: IndexerProcessState["status"]): void {
  _state = { ..._state, status };
}

/** Forward a child output stream line-by-line to the parent's stream with a prefix. */
async function forwardStream(
  source: ReadableStream<Uint8Array> | null | undefined,
  sink: NodeJS.WriteStream,
  prefix: string,
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
      if (buf.length > 0) sink.write(`${prefix} ${buf}\n`);
      return;
    }
    if (!chunk.value) continue;
    buf += decoder.decode(chunk.value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      sink.write(`${prefix} ${line}\n`);
      nl = buf.indexOf("\n");
    }
  }
}

/** Resolve the absolute path to the standalone entry, regardless of cwd. */
function standaloneEntry(): string {
  // import.meta.dir is the directory of this file (control.ts).
  // Bun normalises it to a posix-style absolute path.
  const dir = (import.meta as { dir?: string }).dir ?? __dirname;
  return `${dir}/standalone.ts`;
}

/**
 * Spawn the child process. Idempotent: if a child is already starting/running
 * this is a no-op.
 *
 * Sets `_state.status = "starting"`. The first successful `waitReady()` flips
 * it to "running"; an exit before that flips it to "crashed".
 */
export function spawnChild(): void {
  if (_state.status === "starting" || _state.status === "running") return;

  _stopRequested = false;
  _state = {
    ..._state,
    status: _consecutiveCrashes > 0 ? "restarting" : "starting",
    lastStartedAt: new Date().toISOString(),
    lastError: null,
  };

  // Prefer Bun.spawn when running under Bun; fall back to node:child_process
  // so the supervisor module is at least importable from non-Bun toolchains
  // (the actual tests still need Bun for `bun:ffi` etc.).
  const env = { ...process.env };
  let child: ChildHandle;
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const Bun = (globalThis as unknown as {
      Bun: { spawn: (opts: unknown) => ChildHandle };
    }).Bun;
    child = Bun.spawn({
      cmd: ["bun", standaloneEntry()],
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    // Pipe the streams through so [indexer] logs appear in the parent's output.
    forwardStream(
      child.stdout as ReadableStream<Uint8Array> | null,
      process.stdout,
      "[indexer]",
    ).catch(() => {});
    forwardStream(
      child.stderr as ReadableStream<Uint8Array> | null,
      process.stderr,
      "[indexer]",
    ).catch(() => {});

    // Bun-style: subprocess.exited is a Promise<number>.
    if (child.exited) {
      child.exited.then((code) => onExit(code)).catch(() => onExit(-1));
    }
  } else {
    const cp = nodeSpawn("bun", [standaloneEntry()], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = {
      pid: cp.pid ?? null,
      kill: (sig?: NodeJS.Signals | number) => cp.kill(sig),
    };
    cp.stdout?.on("data", (b: Buffer) => writeLines(b.toString(), process.stdout));
    cp.stderr?.on("data", (b: Buffer) => writeLines(b.toString(), process.stderr));
    cp.on("exit", (code) => onExit(code ?? -1));
  }

  _child = child;
  _state = { ..._state, pid: child.pid ?? null };
}

function writeLines(s: string, sink: NodeJS.WriteStream): void {
  for (const line of s.split("\n")) {
    if (line.length > 0) sink.write(`[indexer] ${line}\n`);
  }
}

function onExit(code: number): void {
  _state = {
    ..._state,
    pid: null,
    lastExitCode: code,
  };
  _child = null;

  if (_healthyResetTimer) {
    clearTimeout(_healthyResetTimer);
    _healthyResetTimer = null;
  }

  if (_stopRequested) {
    _state = { ..._state, status: "stopped", lastError: null };
    return;
  }

  // Crash. Bump counter, decide whether to respawn.
  _consecutiveCrashes++;
  _state = {
    ..._state,
    status: "crashed",
    lastError: `child exited with code ${code}`,
    restartCount: _state.restartCount + (code !== 0 ? 1 : 0),
  };

  if (_consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
    process.stderr.write(
      `[indexer] supervisor: ${_consecutiveCrashes} consecutive crashes — staying down. Use POST /api/indexer/start to retry.\n`,
    );
    return;
  }

  const idx = Math.min(_consecutiveCrashes - 1, BACKOFF_MS.length - 1);
  const delay = BACKOFF_MS[idx];
  process.stderr.write(
    `[indexer] supervisor: child crashed (attempt ${_consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES}) — restarting in ${delay}ms\n`,
  );
  _restartTimer = setTimeout(() => {
    _restartTimer = null;
    spawnChild();
  }, delay);
}

/** Mark the child healthy after `HEALTHY_RESET_MS` of `running`. */
function scheduleHealthyReset(): void {
  if (_healthyResetTimer) clearTimeout(_healthyResetTimer);
  _healthyResetTimer = setTimeout(() => {
    if (_state.status === "running") {
      _consecutiveCrashes = 0;
    }
    _healthyResetTimer = null;
  }, HEALTHY_RESET_MS);
}

/**
 * Stop the child gracefully. Sends SIGTERM and waits up to `STOP_GRACE_MS`
 * for the child to exit; if it doesn't, sends SIGKILL.
 */
export async function stopChild(opts: { graceful?: boolean } = {}): Promise<void> {
  const graceful = opts.graceful !== false;
  _stopRequested = true;

  if (_restartTimer) {
    clearTimeout(_restartTimer);
    _restartTimer = null;
  }

  if (!_child) {
    _state = { ..._state, status: "stopped" };
    return;
  }

  const ch = _child;

  const exitedPromise: Promise<unknown> = ch.exited
    ? ch.exited
    : new Promise((resolve) => {
        // Node fallback: poll for termination because we don't keep an
        // exit listener handle here; the spawn-time `cp.on("exit")` already
        // calls `onExit` which clears `_child`.
        const start = Date.now();
        const tick = setInterval(() => {
          if (!_child) {
            clearInterval(tick);
            resolve(null);
            return;
          }
          if (Date.now() - start > STOP_GRACE_MS + 2_000) {
            clearInterval(tick);
            resolve(null);
          }
        }, 50);
      });

  if (graceful) {
    try {
      ch.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  } else {
    try {
      ch.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }

  // Wait up to STOP_GRACE_MS, then SIGKILL if still alive.
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), STOP_GRACE_MS),
  );
  const result = await Promise.race([exitedPromise.then(() => "exited" as const), timeout]);
  if (result === "timeout" && _child) {
    try {
      ch.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    // Give SIGKILL a brief moment to take effect.
    await Promise.race([
      exitedPromise,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  _state = { ..._state, status: "stopped", pid: null };
}

/**
 * Poll the child's `/status` endpoint until it responds with 200 or the
 * deadline elapses. Resolves on success; rejects with a timeout error.
 *
 * Side effect: on success, flips `_state.status` to `running` and arms the
 * healthy-uptime reset timer.
 */
export async function waitReady(timeoutMs: number = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (_state.status === "stopped") {
      throw new Error("indexer child is stopped");
    }
    try {
      const res = await fetch(targetUrl("/status"), {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        _state = { ..._state, status: "running", lastError: null };
        scheduleHealthyReset();
        return;
      }
      lastErr = new Error(`/status returned HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
  _state = { ..._state, status: "crashed", lastError: `waitReady timeout: ${msg}` };
  throw new Error(`indexer child did not become ready within ${timeoutMs}ms: ${msg}`);
}
