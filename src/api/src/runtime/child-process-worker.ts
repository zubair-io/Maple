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
 *     turns an UNEXPECTED child exit into the `error` event.
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
}

/**
 * A pooled native worker backed by an isolated Bun child process running
 * `scriptPath`. Generic over the wire protocol — it only forwards messages.
 */
export class ChildProcessWorker implements ChildWorkerHost {
  private readonly proc: Bun.Subprocess;
  private readonly label: string;
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
    // stdout/stderr — including a native/Bun crash report on a segfault — flow
    // to the container logs without corrupting the protocol stream.
    this.proc = Bun.spawn([process.execPath, scriptPath], {
      ipc: (message: unknown) => {
        if (this.onMessage) this.onMessage({ data: message });
        else this.pendingMessages.push({ data: message });
      },
      onExit: (_proc, exitCode, signalCode, error) => {
        if (this.terminating) return; // a death we asked for — not a crash
        const detail =
          (signalCode != null ? `signal=${signalCode}` : `exit=${exitCode}`) +
          (error ? ` (${error.message})` : '');
        log.error(
          { label: this.label, pid: this.proc?.pid, exitCode, signalCode },
          `native child died — ${detail}`,
        );
        const ev = { message: `${this.label} child died — ${detail}` };
        if (this.onError) this.onError(ev);
        else this.pendingError = ev;
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      // Bun↔Bun structured-clone IPC — carries typed arrays / nested objects.
      serialization: 'advanced',
      env,
    });
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
