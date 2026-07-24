/**
 * Generic native-work child-process transport + child-side hardening.
 *
 * Extracted/generalized from the FFI decode pool (#882) so BOTH heavy native
 * subsystems — libraw decode (`ffi/`) and the onnx face pipeline
 * (`enrichment/`) — run in isolated child processes instead of Worker threads.
 *
 * Why a child process and not a Worker thread: bun:ffi / onnxruntime-node calls
 * run inline on the calling thread, and a Worker thread shares the API's
 * address space — so a SIGSEGV deep in libraw or ORT on a malformed asset takes
 * down the WHOLE server (not a catchable JS exception). A child process has its
 * own address space: a native crash kills only the child, the parent observes
 * the exit, rejects the in-flight call, and respawns. The uncatchable
 * process-kill becomes a catchable rejection the caller can soft-handle.
 *
 * Two halves:
 *   - `ChildProcessWorker` (parent side): wraps `Bun.spawn` + IPC in the
 *     Worker-like surface (`postMessage` / `terminate` /
 *     `addEventListener('message' | 'error')`) the pools already speak, and
 *     turns an UNEXPECTED child exit into the `error` event. It also pipes the
 *     child's stderr through a small ring buffer (#899): a native crash report
 *     (Rust `panic=abort`, onnxruntime `terminate`, `bad_alloc`, a Bun crash
 *     dump) previously reached ONLY the child's inherited stderr → container
 *     logs, invisible to the structured log pipeline / SigNoz. We still tee
 *     every byte straight through to the parent's own stderr (so `kubectl
 *     logs`/container logs see exactly what `inherit` gave them before — the
 *     tee is lossless), but we ALSO keep the last few KB in memory and fold it
 *     into the structured `onExit` log line as `stderrTail`, so the crash
 *     reason ships with the exit event itself instead of requiring a
 *     separate, unstructured log dive.
 *   - `installChildHardening` (child side): each child entry calls this once to
 *     (a) lower its OS scheduling priority so the HTTP event loop always wins
 *     CPU under indexer load, and (b) self-exit if orphaned (Bun neither
 *     auto-reaps a spawned child on parent death nor reliably fires
 *     `disconnect`).
 */

import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import { child as childLogger } from '../log.ts';

const log = childLogger('native-child');

/** Env var the parent sets at spawn so the child knows how much to `nice`
 * itself. Read child-side by `installChildHardening`. */
const NICE_ENV = 'MAPLE_NATIVE_CHILD_NICE';

/** Default `nice` increment for native decode/inference children. 10 gives the
 * API server (default priority 0) a large scheduling advantage under CPU
 * contention — so HTTP request handling wins over a saturating indexer backlog
 * — while still letting the children make steady progress when the box is idle. */
export const DEFAULT_NATIVE_CHILD_NICE = 10;

/** How much of the child's stderr tail we keep in memory for the crash log
 * (#899). A panic message / backtrace summary is a few hundred bytes to a few
 * KB; 8 KB is generous headroom without holding onto a meaningfully-sized
 * buffer for the life of a long-running child. */
const STDERR_RING_BYTES = 8 * 1024;

/** Upper bound on how long a crash-exit report waits for `pumpStderr` to
 * drain the pipe before logging. Normally the pipe hits EOF within the same
 * event-loop turn as the exit event, so this never bites; it exists so a
 * detached grandchild that inherited the stderr FD can't stall the crash
 * report (and the pool's error event) indefinitely. */
const STDERR_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Fixed-capacity byte ring: keeps only the most recent `maxBytes` written to
 * it. Used to retain just the TAIL of a child's stderr — the part of a crash
 * report (panic message, backtrace) that actually explains the death — without
 * growing unbounded over a long-running child's lifetime. Exported for direct
 * unit testing (see `child-process-worker.test.ts`).
 */
export class StderrRing {
  private chunks: Uint8Array[] = [];
  private len = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.len += chunk.length;
    while (this.len > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const over = this.len - this.maxBytes;
      if (over >= head.length) {
        // Drop the whole oldest chunk.
        this.chunks.shift();
        this.len -= head.length;
      } else {
        // Trim the oldest chunk down to just the bytes we still want.
        // `slice` (copy), not `subarray` (view): a view would pin the whole
        // original ArrayBuffer, so a large stream chunk could keep far more
        // than `maxBytes` resident.
        this.chunks[0] = head.slice(over);
        this.len -= over;
      }
    }
  }

  /** Decode the retained bytes as UTF-8 text, trimmed of surrounding whitespace. */
  toString(): string {
    if (this.chunks.length === 0) return '';
    const merged = new Uint8Array(this.len);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(merged).trim();
  }
}

/** Worker-like surface the pools depend on (matches `Worker` and the pools'
 * injected fakes). Kept structural so `ChildProcessWorker` satisfies both the
 * FFI pool's `PoolWorker` and the face pool's `Worker` usage. */
export interface ChildWorkerHost {
  postMessage(msg: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  addEventListener(type: 'error', cb: (e: { message?: string }) => void): void;
}

type MessageCb = (e: { data: unknown }) => void;
type ErrorCb = (e: { message?: string }) => void;

export interface ChildProcessWorkerOptions {
  /** `nice` increment for the child (0–19; higher = lower priority). The HTTP
   * server runs at the parent's priority, so a positive value makes native
   * work yield CPU to request handling under load. */
  nice?: number;
  /** Short label for diagnostics (which subsystem this child serves). */
  label?: string;
  /** Extra command-line arguments appended after the script path.
   * The child reads them via `process.argv.slice(2)`.
   * Defaults to `[]` — existing callers that pass no argv are unaffected. */
  argv?: string[];
}

/**
 * A pooled native worker backed by an isolated Bun child process running
 * `scriptPath`. Generic over the wire protocol — it only forwards messages.
 */
export class ChildProcessWorker implements ChildWorkerHost {
  private readonly proc: Bun.Subprocess<'ignore', 'inherit', 'pipe'>;
  private readonly label: string;
  /** Tail of the child's stderr, kept for the crash-diagnostic `onExit` log
   * (#899). Fed by `pumpStderr`. */
  private readonly stderrRing = new StderrRing(STDERR_RING_BYTES);
  /** Resolves when `pumpStderr` has drained the pipe to EOF. The crash-exit
   * path awaits this (bounded) so the ring holds the child's FINAL stderr
   * chunks before the exit log reads it — `onExit` can otherwise fire before
   * the last pipe read is processed. */
  private readonly stderrDrained: Promise<void>;
  private onMessage: MessageCb | null = null;
  private onError: ErrorCb | null = null;
  /** Set once WE asked the child to die (terminate), so its `onExit` isn't
   * misread as a crash. */
  private terminating = false;
  /** Buffer events that arrive before listeners attach. The pools attach
   * synchronously right after construction, so these normally stay empty —
   * kept only so an early event can never be dropped. */
  private readonly pendingMessages: Array<{ data: unknown }> = [];
  private pendingError: { message?: string } | null = null;

  constructor(scriptPath: string, opts: ChildProcessWorkerOptions = {}) {
    this.label = opts.label ?? 'native-child';
    const env = { ...process.env };
    if (opts.nice && opts.nice > 0) env[NICE_ENV] = String(Math.floor(opts.nice));
    // Spawn under the same Bun runtime (bun:ffi / onnxruntime-node require it).
    // `ipc` opens a dedicated channel separate from stdio, so the child's
    // stdout/stderr — including a native/Bun crash report on a segfault — never
    // corrupt the protocol stream. stdout stays `inherit`; stderr is `pipe` so
    // `pumpStderr` can tee it through to the container logs AND retain the tail
    // for the crash-diagnostic `onExit` log (#899).
    this.proc = Bun.spawn([process.execPath, scriptPath, ...(opts.argv ?? [])], {
      ipc: (message: unknown) => {
        if (this.onMessage) this.onMessage({ data: message });
        else this.pendingMessages.push({ data: message });
      },
      onExit: (_proc, exitCode, signalCode, error) => {
        if (this.terminating) return; // a death we asked for — not a crash
        void this.reportCrashExit(exitCode, signalCode, error);
      },
      // stderr is piped (not inherited) so the parent can tee it into the ring
      // buffer above — see `pumpStderr`. stdout stays inherited: it's ordinary
      // child chatter, not the crash-diagnostic signal this ticket cares about.
      stdio: ['ignore', 'inherit', 'pipe'],
      // Bun↔Bun structured-clone IPC — carries typed arrays / nested objects.
      serialization: 'advanced',
      env,
    });
    this.stderrDrained = this.pumpStderr();
  }

  /**
   * Crash-exit continuation for `onExit`. Waits (bounded) for `pumpStderr` to
   * drain the pipe so the ring buffer contains the child's final words —
   * `onExit` fires on process death, which can beat the event loop's last
   * pipe read. The timeout keeps a detached grandchild that inherited the
   * pipe from stalling the crash report indefinitely.
   */
  private async reportCrashExit(
    exitCode: number | null,
    signalCode: string | number | null,
    error: { message?: string } | undefined,
  ): Promise<void> {
    // The fallback timer is cleared once the race settles — otherwise every
    // crash exit leaves a live 2s timer holding the event loop open, which
    // adds up under a crash loop (#897) and delays graceful shutdown.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.stderrDrained,
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, STDERR_DRAIN_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(drainTimer));
    const detail =
      (signalCode != null ? `signal=${signalCode}` : `exit=${exitCode}`) +
      (error ? ` (${error.message})` : '');
    // #899: fold in whatever the child wrote to stderr right before it
    // died — a Rust panic message, an onnxruntime `terminate called after
    // throwing`, a `bad_alloc`, a Bun crash-report header — so the exit
    // event is self-diagnosing instead of pointing at container logs.
    const stderrTail = this.stderrRing.toString();
    log.error(
      {
        label: this.label,
        pid: this.proc?.pid,
        exitCode,
        signalCode,
        ...(stderrTail ? { stderrTail } : {}),
      },
      `native child died — ${detail}`,
    );
    const ev = { message: `${this.label} child died — ${detail}` };
    if (this.onError) this.onError(ev);
    else this.pendingError = ev;
  }

  /**
   * Continuously drain the child's piped stderr: tee every chunk straight to
   * the parent's OWN stderr — so container logs / `kubectl logs` see exactly
   * what plain `inherit` gave them before (the tee is lossless, nothing is
   * summarized or dropped on the live path) — and retain the tail in
   * `stderrRing` for the structured `onExit` crash log. Runs for the child's
   * lifetime; resolves once the pipe closes (the child exited, gracefully or
   * not).
   */
  private async pumpStderr(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          process.stderr.write(value);
          this.stderrRing.push(value);
        }
      }
    } catch {
      // The pipe errored or was torn down mid-read (e.g. the child was
      // SIGKILLed out from under us). Nothing more to drain — whatever landed
      // in the ring buffer beforehand is still available for the exit log.
    } finally {
      reader.releaseLock();
    }
  }

  /** Underlying OS pid. Exposed for diagnostics and crash-isolation tests. */
  get pid(): number {
    return this.proc.pid;
  }

  postMessage(msg: unknown): void {
    this.proc.send(msg);
  }

  terminate(): void {
    this.terminating = true;
    try {
      this.proc.kill();
    } catch {
      // best-effort — the child may already be dead
    }
  }

  addEventListener(type: 'message', cb: MessageCb): void;
  addEventListener(type: 'error', cb: ErrorCb): void;
  addEventListener(type: 'message' | 'error', cb: MessageCb | ErrorCb): void {
    if (type === 'message') {
      this.onMessage = cb as MessageCb;
      const buffered = this.pendingMessages.splice(0);
      for (const e of buffered) this.onMessage(e);
    } else {
      this.onError = cb as ErrorCb;
      if (this.pendingError) {
        const e = this.pendingError;
        this.pendingError = null;
        this.onError(e);
      }
    }
  }
}

/** Resolve a child entry's filesystem path from a `import.meta.url`-relative
 * specifier. Helper so each pool can name its child script cleanly. */
export function childScriptPath(metaUrl: string, relative: string): string {
  return fileURLToPath(new URL(relative, metaUrl));
}

/**
 * Child-side hardening — call once at the top of every native child entry.
 *
 * 1. **Nice**: lower this process's scheduling priority by `MAPLE_NATIVE_CHILD_NICE`
 *    (set by the parent at spawn). The API server stays at default priority, so
 *    its HTTP event loop is scheduled ahead of this CPU-bound native work even
 *    when the box is saturated by an indexing backlog — that's what keeps the
 *    server responsive while workers run.
 * 2. **Orphan guard**: if the parent dies ungracefully (SIGKILL/OOM/crash) the
 *    pool's `terminate()` never runs and Bun doesn't auto-reap us; `disconnect`
 *    is unreliable. Watch the parent pid and exit once it changes (parent gone
 *    → re-parented to init), so we never linger as an orphan. The timer is
 *    unref'd so it never keeps an otherwise-idle child alive on its own.
 */
export function installChildHardening(label: string): void {
  const incRaw = Number(process.env[NICE_ENV] ?? '0');
  const increment = Number.isFinite(incRaw) ? Math.max(0, Math.min(19, Math.floor(incRaw))) : 0;
  if (increment > 0) {
    try {
      // `MAPLE_NATIVE_CHILD_NICE` is a RELATIVE increment, but `os.setPriority`
      // sets an ABSOLUTE nice value — so add it to the priority this child
      // inherited from the parent at spawn rather than overwriting it. That
      // keeps the child strictly below the parent (the HTTP server) even when
      // the parent is itself niced (a container/systemd `Nice=`). `increment`
      // is non-negative and we clamp to 19, so we only ever RAISE our own
      // niceness — always permitted without privileges.
      const current = os.getPriority(); // this process — inherited from the parent
      os.setPriority(0, Math.min(19, current + increment));
    } catch (e) {
      // Best-effort: some sandboxes disallow setpriority. Not fatal — the child
      // just runs at the inherited priority.
      log.warn({ label, err: e instanceof Error ? e.message : String(e) }, 'setPriority failed');
    }
  }

  const parentPid = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== parentPid) process.exit(0);
  }, 2000);
  (watch as unknown as { unref?: () => void }).unref?.();
}
