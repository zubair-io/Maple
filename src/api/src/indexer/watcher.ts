/**
 * Filesystem watcher — wraps chokidar with a 250 ms debounce window.
 *
 * Each watched path emits typed `WatchEvent`s that are fed into the
 * discover channel. Renames are reported by chokidar as a pair of
 * `unlink` + `add` within a short window; we coalesce those by path
 * similarity inside a per-folder debounce buffer.
 */

import chokidar, { type FSWatcher } from "chokidar";
import * as path from "node:path";
import { child as childLogger } from "../log.ts";

const log = childLogger("watcher");

export type WatchKind = "created" | "modified" | "renamed" | "removed";

export interface WatchEvent {
  kind: WatchKind;
  absPath: string;
  /** Only set for renames — previous absolute path. */
  fromPath?: string;
}

export interface WatcherOptions {
  /** Absolute folder paths to watch. */
  roots: string[];
  /** Debounce window in ms (default 250). */
  debounceMs?: number;
  /** File extensions to include (lowercase, with leading dot). */
  include?: Set<string>;
  /** Callback invoked for each batched event. */
  onEvent: (event: WatchEvent) => void;
}

interface Pending {
  add: Set<string>;
  change: Set<string>;
  unlink: Set<string>;
}

function emptyPending(): Pending {
  return { add: new Set(), change: new Set(), unlink: new Set() };
}

export class Watcher {
  private readonly watcher: FSWatcher;
  private readonly debounceMs: number;
  private readonly include: Set<string> | null;
  private readonly onEvent: (event: WatchEvent) => void;

  private pending: Pending = emptyPending();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 250;
    this.include = opts.include ?? null;
    this.onEvent = opts.onEvent;

    // Polling instead of inotify. Chokidar's default uses one inotify
    // watch per file on Linux, which exhausts both the per-process fd
    // limit AND the kernel-wide `fs.inotify.max_user_watches` cap on
    // libraries with >10k photos (we hit EMFILE on a 1524-asset deploy
    // even with the per-process ulimit raised to 524288 — the kernel
    // inotify cap was the binding constraint).
    //
    // Polling uses zero inotify watches and zero persistent file handles
    // — just `stat()` calls on a timer. Cost is `(file count) * stats
    // per interval`. For a 5TB photo library (~500k files), even a 30s
    // interval is ~17k stats/s — measurable. We dial way up because a
    // photo library is import-and-walk-away, not real-time:
    //
    //   binaryInterval (5 min)  — RAW, JPEG, HEIC, video. The 99% case.
    //   interval        (1 min) — sidecars, metadata, anything chokidar
    //                             can't classify as binary.
    //
    // Operators who want a faster tempo can override at runtime via
    // env vars (TBD if anyone asks); for now, edit here.
    this.watcher = chokidar.watch(opts.roots, {
      persistent: true,
      ignoreInitial: true, // startup walk is driven by the checkpoint logic
      usePolling: true,
      interval: 60_000,
      binaryInterval: 300_000,
      ignored: (p: string) => {
        const base = path.basename(p);
        if (base.startsWith(".")) return true; // hides .maple/, dotfiles
        return false;
      },
    });

    this.watcher.on("add", (p) => this.enqueue("add", p));
    this.watcher.on("change", (p) => this.enqueue("change", p));
    this.watcher.on("unlink", (p) => this.enqueue("unlink", p));
    this.watcher.on("error", (err) => {
      log.warn({ err: err instanceof Error ? err.message : err }, "error");
    });
  }

  private allowed(p: string): boolean {
    if (!this.include) return true;
    return this.include.has(path.extname(p).toLowerCase());
  }

  private enqueue(kind: "add" | "change" | "unlink", p: string): void {
    if (!this.allowed(p)) return;
    if (kind === "add") this.pending.add.add(p);
    else if (kind === "change") this.pending.change.add(p);
    else this.pending.unlink.add(p);

    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = null;
    const batch = this.pending;
    this.pending = emptyPending();

    // Rename coalescing: if an unlink and an add share the same basename and
    // landed in the same debounce window, treat it as a rename.
    const renamed = new Map<string, string>(); // fromPath -> toPath
    for (const rm of [...batch.unlink]) {
      const base = path.basename(rm);
      for (const adj of [...batch.add]) {
        if (path.basename(adj) === base) {
          renamed.set(rm, adj);
          batch.unlink.delete(rm);
          batch.add.delete(adj);
          break;
        }
      }
    }

    for (const [from, to] of renamed) {
      this.onEvent({ kind: "renamed", absPath: to, fromPath: from });
    }
    for (const p of batch.add) this.onEvent({ kind: "created", absPath: p });
    for (const p of batch.change) this.onEvent({ kind: "modified", absPath: p });
    for (const p of batch.unlink) this.onEvent({ kind: "removed", absPath: p });
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.watcher.close();
  }
}
