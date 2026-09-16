import type { PoolWorker, WorkerFactory } from '../src/ffi/ffi-pool.ts';

export interface RequestTiming {
  label: string;
  submittedMs: number;
  dispatchedMs: number | null;
  repliedMs: number | null;
  settledMs: number | null;
  status: 'pending' | 'ok' | 'failed';
  error?: string;
}

/** Harness-only observer at the real pool's existing worker-factory seam.
 * Queue wait includes lazy child spawn; service time includes IPC/startup.
 * It does not measure the child's native decode in isolation. */
export class ContentionObserver {
  readonly requests: RequestTiming[] = [];
  private readonly byPath = new Map<string, RequestTiming>();
  private readonly byId = new Map<number, RequestTiming>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  async measure(label: string, path: string, run: () => Promise<unknown>): Promise<void> {
    if (this.byPath.has(path)) throw new Error(`duplicate request path: ${path}`);
    const row: RequestTiming = {
      label,
      submittedMs: this.now(),
      dispatchedMs: null,
      repliedMs: null,
      settledMs: null,
      status: 'pending',
    };
    this.requests.push(row);
    this.byPath.set(path, row);
    try {
      await run();
      if (row.dispatchedMs === null || row.repliedMs === null) {
        throw new Error('missing dispatch/reply observation');
      }
      row.status = 'ok';
    } catch (error) {
      row.status = 'failed';
      row.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      row.settledMs = this.now();
      this.byPath.delete(path);
    }
  }

  factory(create: WorkerFactory): WorkerFactory {
    return () => {
      const worker = create();
      const observed: PoolWorker = {
        postMessage: (message: unknown) => {
          const request = message as { id: number; outPath?: string; filePath?: string };
          const row = this.byPath.get(request.outPath ?? request.filePath ?? '');
          if (!row) throw new Error('unregistered contention request');
          row.dispatchedMs = this.now();
          this.byId.set(request.id, row);
          worker.postMessage(message);
        },
        terminate: () => worker.terminate(),
        addEventListener: (type: 'message' | 'error', callback: (event: never) => void) => {
          if (type === 'message') {
            worker.addEventListener('message', (event) => {
              const reply = event.data as { id?: number };
              const row = reply.id === undefined ? undefined : this.byId.get(reply.id);
              if (row) row.repliedMs = this.now();
              callback(event as never);
            });
          } else {
            worker.addEventListener('error', (event) => callback(event as never));
          }
        },
      };
      return observed;
    };
  }

  report() {
    return this.requests.map((row) => ({
      ...row,
      queueMs: row.dispatchedMs === null ? null : row.dispatchedMs - row.submittedMs,
      dispatchToReplyMs:
        row.dispatchedMs === null || row.repliedMs === null
          ? null
          : row.repliedMs - row.dispatchedMs,
      totalMs: row.settledMs === null ? null : row.settledMs - row.submittedMs,
    }));
  }
}

export interface RssSample {
  elapsedMs: number;
  parentRssBytes: number;
  children: Array<{ pid: number; rssBytes: number }>;
  childRssBytes: number;
}

/** macOS/Linux ps reports RSS in KiB. Select only direct FFI children of this
 * harness, never other API instances or the sampling ps process itself. */
export function parseRssSnapshot(output: string, parentPid: number, elapsedMs: number): RssSample {
  const processes = output
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) throw new Error(`invalid ps row: ${line}`);
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rss: Number(match[3]) * 1024,
        command: match[4],
      };
    });
  const parent = processes.find((row) => row.pid === parentPid);
  if (!parent) throw new Error('harness process absent from RSS snapshot');
  const children = processes
    .filter(
      (row) => row.ppid === parentPid && /(?:^|\/)raw_ffi\.child\.ts(?:\s|$)/.test(row.command),
    )
    .map((row) => ({ pid: row.pid, rssBytes: row.rss }));
  return {
    elapsedMs,
    parentRssBytes: parent.rss,
    children,
    childRssBytes: children.reduce((sum, child) => sum + child.rssBytes, 0),
  };
}
