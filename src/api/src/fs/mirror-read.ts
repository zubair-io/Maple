/**
 * Mirror read replica — choosing WHICH copy of a file to read.
 *
 * The write side (`mirrored.ts` + the mirror queue/worker) makes a library's
 * backup root a faithful shadow of its primary. This module is the read side:
 * it lets a request be served from that shadow, either to spread read load or
 * because the primary volume is unreachable.
 *
 * Two different contracts, because two different kinds of file:
 *
 *   - **Originals** (`resolveOriginalReadSource`). Maple never modifies an
 *     original in place (root CLAUDE.md principle 1), so a mirror copy with the
 *     same size and mtime is not "probably" the same file — it is the same
 *     file. Those reads round-robin across primary + mirrors. Length and ETag
 *     are always taken from the authoritative copy, so which replica served a
 *     given request is invisible to the client and to caches.
 *
 *   - **Sidecars** (`readFileWithFailover`). XMP is mutable: the primary is
 *     authoritative and a mirror may legitimately lag by a queue drain. These
 *     reads stay on the primary and only fall back to a replica when the
 *     primary *location* is unreachable — never when the primary is healthy and
 *     the file is simply absent, which would resurrect a deleted sidecar.
 *
 * ## What "unreachable" means
 *
 * An unmounted volume ENOENTs its files exactly like a deleted file does, so
 * "the read failed" is not by itself grounds to consult a replica. The
 * discriminator is the library's own primary root: a failed read whose primary
 * root is still a readable directory is a genuine miss (404), and only a failed
 * read whose primary root has itself gone away is a failover.
 *
 * ## Health
 *
 * `resolveMirrorTargets` already only yields mirrors the operator has left
 * `enabled` (`mirror-config.ts` filters on it when loading the registry), so
 * this module layers one more gate on top: a mirror root that times out or
 * errors on I/O is benched for a cooldown and skipped by both paths. Timeouts
 * matter more than the error case — a wedged network mount blocks `stat`
 * indefinitely rather than failing, and an unbounded wait there would turn a
 * dead backup disk into a hung request on the primary.
 *
 * Deliberately uses the REAL `node:fs/promises`: these are reads, and reads
 * must never re-enter the replication machinery.
 */

import { readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { resolveMirrorTargets, isMirroringActive, type MirrorTarget } from './mirror-registry.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/mirror-read');

/** How long a mirror root stays benched after an I/O failure or a timeout. */
const UNHEALTHY_COOLDOWN_MS = 60_000;

/** Ceiling on a single mirror-side `stat`/`readFile`. A wedged network mount
 * hangs rather than failing; without this the health signal could never fire. */
const MIRROR_IO_TIMEOUT_MS = 2_000;

/**
 * Size is exact and mtime is preserved by every replication path
 * (`replicateFile`, `copyFileToMirror`), but filesystems disagree on mtime
 * granularity (HFS+ 1s, exFAT 2s), so allow the same 1s slack the replication
 * staleness check uses.
 */
const MTIME_TOLERANCE_MS = 1_000;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** mirror root → epoch-ms until which it is benched. */
const _benchedUntil = new Map<string, number>();

/** Bench a mirror root: no read is routed to it until the cooldown expires. */
export function markMirrorUnhealthy(mirrorRoot: string): void {
  const until = Date.now() + UNHEALTHY_COOLDOWN_MS;
  if (!_benchedUntil.has(mirrorRoot)) {
    log.warn({ mirrorRoot }, 'mirror benched for reads — I/O failure or timeout');
  }
  _benchedUntil.set(mirrorRoot, until);
}

/** Clear a bench after a successful read from that root. */
function markMirrorHealthy(mirrorRoot: string): void {
  _benchedUntil.delete(mirrorRoot);
}

/** True when reads may be routed to this mirror root. */
function isMirrorHealthy(mirrorRoot: string): boolean {
  const until = _benchedUntil.get(mirrorRoot);
  if (until === undefined) return true;
  if (Date.now() >= until) {
    // Cooldown elapsed — let the next read probe it again.
    _benchedUntil.delete(mirrorRoot);
    return true;
  }
  return false;
}

/** Drop all health state (tests, and after a mirror config change). */
export function resetMirrorHealth(): void {
  _benchedUntil.clear();
}

/** Currently-benched mirror roots with their remaining cooldown, for the
 * operator status readout. Expired entries are omitted. */
export function benchedMirrors(): { root: string; retryInMs: number }[] {
  const now = Date.now();
  return [..._benchedUntil.entries()]
    .filter(([, until]) => until > now)
    .map(([root, until]) => ({ root, retryInMs: until - now }));
}

// ---------------------------------------------------------------------------
// Candidate resolution
// ---------------------------------------------------------------------------

/** Enabled (per the registry) AND healthy (per the bench) mirror targets. */
function readableTargets(absPath: string): MirrorTarget[] {
  if (!isMirroringActive()) return [];
  return resolveMirrorTargets(absPath).filter((t) => isMirrorHealthy(t.mirrorRoot));
}

/** Round-robin cursor, shared by every original-byte read in this process. */
let _cursor = 0;

function nextReplica(count: number): number {
  _cursor = (_cursor + 1) % Number.MAX_SAFE_INTEGER;
  return _cursor % count;
}

/** Reset the round-robin cursor so a test can assert a deterministic sequence. */
export function resetReadBalancer(): void {
  _cursor = 0;
}

function isErrno(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === code;
}

/** Run a mirror-side I/O op under a timeout so a wedged mount can't hang the
 * request. Rejects with a synthetic timeout error the caller treats as unhealthy.
 * The timer is always cleared, so a fast read leaves nothing pending. */
async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`mirror I/O timed out after ${MIRROR_IO_TIMEOUT_MS}ms`)),
      MIRROR_IO_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `stat` a mirror path, updating that root's health. Returns null when the
 * mirror simply doesn't have the file — an absent file is not a sick disk, and
 * an unmounted volume reports its contents absent rather than erroring, so only
 * a real I/O error or a timeout benches the root.
 */
async function statMirror(t: MirrorTarget): Promise<Stats | null> {
  try {
    const st = await withTimeout(stat(t.mirrorPath));
    markMirrorHealthy(t.mirrorRoot);
    return st.isFile() ? st : null;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    markMirrorUnhealthy(t.mirrorRoot);
    return null;
  }
}

/** True when a mirror copy is provably the same file as the primary. */
function isFaithfulReplica(primary: Stats, mirror: Stats): boolean {
  return (
    primary.size === mirror.size && Math.abs(primary.mtimeMs - mirror.mtimeMs) <= MTIME_TOLERANCE_MS
  );
}

/** stat a path, yielding null unless it is a readable regular file. */
async function statFileOrNull(p: string): Promise<Stats | null> {
  try {
    const st = await stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * Is the library's own primary root still a readable directory? This is the
 * discriminator between "this file is gone" and "this volume is gone" — see the
 * module doc. Every target of one path shares a `primaryRoot`, so one check
 * covers the whole candidate set.
 */
async function isPrimaryRootReachable(targets: MirrorTarget[]): Promise<boolean> {
  const root = targets[0]?.primaryRoot;
  if (root === undefined) return true;
  try {
    return (await stat(root)).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Originals — round-robin + failover
// ---------------------------------------------------------------------------

export interface OriginalReadSource {
  /** The replica to stream bytes from. */
  path: string;
  /**
   * Stat of the AUTHORITATIVE copy — the primary's whenever the primary is
   * readable. Callers derive Content-Length and ETag from this, so a response
   * is byte-for-byte and header-for-header identical whichever replica served.
   */
  stat: Stats;
  origin: 'primary' | 'mirror';
}

/**
 * Pick where to read an original's bytes from.
 *
 * With the primary readable: round-robin across primary + healthy mirrors, and
 * only use the mirror copy when it is provably the same file. Any doubt (absent,
 * different size, drifted mtime, I/O error) falls back to the primary — the
 * mirror is an optimisation, never a source of truth.
 *
 * With the primary unreadable: a miss on a healthy primary volume stays a miss.
 * Only when the primary ROOT is itself unreachable do we serve from a mirror,
 * using that replica's own stat for the response headers.
 *
 * Returns null when no location can serve the file (the caller 404s).
 */
export async function resolveOriginalReadSource(
  absPath: string,
): Promise<OriginalReadSource | null> {
  const targets = readableTargets(absPath);
  const primaryStat = await statFileOrNull(absPath);

  if (primaryStat !== null) {
    const primary: OriginalReadSource = { path: absPath, stat: primaryStat, origin: 'primary' };
    if (targets.length === 0) return primary;
    const pick = nextReplica(targets.length + 1);
    if (pick === 0) return primary;
    const target = targets[pick - 1]!;
    const mirrorStat = await statMirror(target);
    if (mirrorStat === null || !isFaithfulReplica(primaryStat, mirrorStat)) return primary;
    return { path: target.mirrorPath, stat: primaryStat, origin: 'mirror' };
  }

  if (targets.length === 0) return null;
  if (await isPrimaryRootReachable(targets)) return null;
  for (const target of targets) {
    const mirrorStat = await statMirror(target);
    if (mirrorStat !== null) {
      log.warn({ absPath, mirror: target.mirrorPath }, 'primary unreachable — serving from mirror');
      return { path: target.mirrorPath, stat: mirrorStat, origin: 'mirror' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutable files — primary-only, with failover
// ---------------------------------------------------------------------------

/** Read a mirror copy under the timeout + health accounting. Null on any miss. */
async function readMirrorFile(t: MirrorTarget): Promise<string | null> {
  try {
    const text = await withTimeout(readFile(t.mirrorPath, 'utf-8'));
    markMirrorHealthy(t.mirrorRoot);
    return text;
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) markMirrorUnhealthy(t.mirrorRoot);
    return null;
  }
}

/**
 * Read a UTF-8 file, preferring the primary and falling back to a mirror ONLY
 * when the primary location is unreachable. The contract for mutable content
 * (XMP sidecars): a mirror may lag the primary by one queue drain, so it is a
 * last resort for availability, never a load-balancing target. Rethrows the
 * primary's original error when no replica can serve it, so callers keep their
 * existing error messages.
 */
export async function readFileWithFailover(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, 'utf-8');
  } catch (err) {
    const targets = readableTargets(absPath);
    if (targets.length === 0) throw err;
    if (await isPrimaryRootReachable(targets)) throw err;
    for (const target of targets) {
      const text = await readMirrorFile(target);
      if (text !== null) {
        log.warn({ absPath, mirror: target.mirrorPath }, 'primary unreachable — read from mirror');
        return text;
      }
    }
    throw err;
  }
}
