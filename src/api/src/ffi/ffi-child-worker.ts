/**
 * Child-process transport for the FFI decode pool.
 *
 * Wraps a `Bun.spawn`'d `raw_ffi.child.ts` process in the `PoolWorker`
 * interface the pool already speaks (`postMessage` / `terminate` /
 * `addEventListener('message' | 'error')`), so `ffi-pool.ts`'s dispatch,
 * resize, and crash-recovery logic — and all of its tests, which inject a fake
 * `PoolWorker` — are untouched. Only the transport changed: Bun Worker THREAD
 * (shared address space; a native SIGSEGV killed the whole API process) → child
 * PROCESS (isolated; a native crash kills only the child, the parent recovers).
 *
 * Crash → `error` event: Bun's `onExit` fires for BOTH a clean `terminate()`
 * (pool shrink / shutdown) and an unexpected death (the decoder segfaulted).
 * We fire the pool's `error` handler ONLY for the unexpected case — a death we
 * didn't ask for — so a normal shrink doesn't look like a crash. The pool's
 * `error` path then rejects just this child's in-flight call and respawns.
 */

import { fileURLToPath } from 'node:url';
import { child as childLogger } from '../log.ts';
import type { PoolWorker, WorkerFactory } from './ffi-pool.ts';

const log = childLogger('ffi:child');

const CHILD_SCRIPT = fileURLToPath(new URL('./raw_ffi.child.ts', import.meta.url));

type MessageCb = (e: { data: unknown }) => void;
type ErrorCb = (e: { message?: string }) => void;

/** A pooled FFI decoder backed by an isolated Bun child process. */
export class ChildProcessWorker implements PoolWorker {
  private readonly proc: Bun.Subprocess;
  private onMessage: MessageCb | null = null;
  private onError: ErrorCb | null = null;
  /** Set true once WE asked the child to die (terminate), so its `onExit`
   * isn't misread as a crash. */
  private terminating = false;
  /** Buffer messages/errors that arrive before the pool attaches listeners.
   * In practice the pool attaches synchronously right after construction, so
   * these stay empty — kept purely so an early event can never be dropped. */
  private readonly pendingMessages: Array<{ data: unknown }> = [];
  private pendingError: { message?: string } | null = null;

  constructor() {
    // Spawn the child under the same Bun runtime (bun:ffi requires Bun).
    // `ipc` opens a dedicated message channel (separate from stdio), so the
    // child's stdout/stderr — including a libraw/Bun crash report on a segfault
    // — flow to the container logs without corrupting the protocol stream.
    this.proc = Bun.spawn([process.execPath, CHILD_SCRIPT], {
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
          { pid: this.proc?.pid, exitCode, signalCode },
          `FFI decode child died — ${detail}`,
        );
        const ev = { message: `ffi child died — ${detail}` };
        if (this.onError) this.onError(ev);
        else this.pendingError = ev;
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      // Bun↔Bun structured-clone IPC — handles the histogram bins object.
      serialization: 'advanced',
    });
  }

  /** Underlying OS pid. Exposed for diagnostics and the crash-isolation test. */
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

/** Production factory: spawn a real isolated FFI decode child process. */
export const defaultChildWorkerFactory: WorkerFactory = () => new ChildProcessWorker();
