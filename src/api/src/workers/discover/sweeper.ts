/**
 * Discover reconciliation sweep — the chokidar replacement. Walks one directory
 * per call: enqueues subdirs onto the frontier, emits created/modified for new
 * or changed images via the injected `handleEvent`, and emits removed for
 * assets recorded in this dir whose file is gone (per-directory diff — no
 * whole-tree state, no per-asset "seen" write).
 */
import path from 'node:path';
import { promises as fs, type Dirent } from 'node:fs';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { SUPPORTED_EXTS, toPosixRelDir } from './types.ts';
import type { WatchEvent } from './types.ts';
import { DUPLICATES_DIR_NAME } from '../../fs/duplicates.ts';
import * as frontier from './frontier.repo.ts';
import type { FrontierDir } from './frontier.repo.ts';
import { readCheckpoint, writeCheckpoint } from '../../indexer/checkpoint.ts';
import { libraryRootAvailable, statKind } from '../missing-reaper.helpers.ts';
import { child } from '../../log.ts';

const log = child('discover');

export interface ReconcileDeps {
  handleEvent: (event: WatchEvent, folderId: ObjectId, libraryRoot: string) => Promise<void>;
  folderId: ObjectId;
  /** Directory reader — injectable so tests can simulate an incomplete/truncated
   * listing (the network-share failure mode the stat-confirm in the removed pass
   * guards against). Defaults to `fs.readdir(dir, { withFileTypes: true })`. */
  readDir?: (dirPath: string) => Promise<Dirent[]>;
}

function isSupported(name: string): boolean {
  return SUPPORTED_EXTS.has(path.extname(name).toLowerCase());
}

export async function visitDirectory(
  dir: FrontierDir,
  root: string,
  deps: ReconcileDeps,
): Promise<void> {
  const { folderId } = deps;
  let entries: Dirent[];
  try {
    const readDir = deps.readDir ?? ((p: string) => fs.readdir(p, { withFileTypes: true }));
    entries = await readDir(dir.dir_path);
  } catch {
    // Vanished/unreadable dir: drop it from the frontier and move on.
    await frontier.completeDir(dir._id);
    return;
  }

  const subdirs: string[] = [];
  const filesOnDisk = new Map<string, string>(); // filename -> absPath (images only)

  for (const ent of entries) {
    const abs = path.join(dir.dir_path, ent.name);
    if (ent.isDirectory()) {
      // Never descend into:
      //   - the DeDuplicate quarantine. A moved copy is byte-identical to the
      //     kept one, so re-discovering it would re-attach its location to the
      //     very asset it was split from (content-dedup). This skip is what
      //     makes the move stick.
      //   - any dotdir. In particular `.maple/` — our own cache of derived
      //     thumbs/previews. Indexing the cache turns each entry into a
      //     phantom asset whose thumb/preview outputs land one `.maple/`
      //     deeper than the file (see `fs/xmp.ts` path math), which the next
      //     sweep then indexes too — a self-feeding `.maple/.maple/.../…jpg`
      //     loop. Matches the pattern other walkers already use
      //     (`workers/cache-gc.ts`, `routes/folders.ts`).
      if (ent.name === DUPLICATES_DIR_NAME || ent.name.startsWith('.')) continue;
      subdirs.push(abs);
      continue;
    }
    // Skip non-files, non-images, and dotfiles (e.g. `.DS_Store`, AppleDouble
    // `._foo.jpg` resource forks — their extension matches but their content
    // doesn't).
    if (!ent.isFile() || !isSupported(ent.name) || ent.name.startsWith('.')) continue;
    filesOnDisk.set(ent.name, abs);
  }

  // ONE indexed read per dir: the non-deleted assets recorded directly in it.
  // Drives BOTH "what's new" and "what's gone" — so writes happen only on real
  // changes, never a per-file upsert storm.
  const rel = toPosixRelDir(path.relative(root, dir.dir_path));
  const coll = await assetsCollection();
  const recorded = (await coll
    .find(
      { deleted_at: null, fileinfo: { $elemMatch: { library_id: folderId, path: rel } } },
      { projection: { 'fileinfo.$': 1 } },
    )
    .toArray()) as Array<{ fileinfo: Array<{ filename: string }> }>;
  const recordedNames = new Set<string>();
  for (const a of recorded) {
    const fn = a.fileinfo?.[0]?.filename;
    if (fn) recordedNames.add(fn);
  }

  // New files only → created (handleEvent upserts the stage skeleton). Files
  // already recorded are SKIPPED — no write.
  for (const [name, abs] of filesOnDisk) {
    if (recordedNames.has(name)) continue;
    await deps.handleEvent({ kind: 'created', absPath: abs }, folderId, root);
  }

  // Recorded files not seen in the listing → candidate removals. A missing
  // entry is NOT trusted on its own: a `fs.readdir` can succeed yet return an
  // incomplete set on a network share (SMB blip). Re-stat each candidate and
  // only emit `removed` on a genuine ENOENT. A present file or an inconclusive
  // stat error (EACCES/EIO/timeout) is left for the next sweep, so a truncated
  // listing can never mass-tag present files `missing_since`. (On a
  // normalization-insensitive filesystem this also absorbs an NFC/NFD name
  // mismatch that the exact-string listing check would miss; on a byte-exact
  // filesystem such a mismatch is a genuine indexing bug, not a false removal.)
  //
  // Even a confirmed per-file ENOENT is not enough when the LIBRARY ROOT is
  // unavailable (#2171): an unmounted bind/network mount is a present-but-
  // EMPTY directory under which every stat ENOENTs, so a per-candidate stat
  // cannot tell "file deleted" from "whole volume gone". Before the first
  // removal is emitted, confirm the root is listable and non-empty; if not,
  // emit nothing this visit and let a later sweep (mount restored) decide.
  await emitConfirmedRemovals(recorded, filesOnDisk, dir.dir_path, root, deps);

  await frontier.enqueueDirs(folderId, subdirs, dir.sweep_gen);
  await frontier.completeDir(dir._id);
}

/** The removal pass of `visitDirectory`: re-stat each recorded-but-unlisted
 * candidate and emit `removed` only on a confirmed ENOENT under an available
 * library root. The root check is lazy — one readdir per visit, and only when
 * a candidate actually confirmed absent. */
async function emitConfirmedRemovals(
  recorded: Array<{ fileinfo: Array<{ filename: string }> }>,
  filesOnDisk: ReadonlyMap<string, string>,
  dirPath: string,
  root: string,
  deps: ReconcileDeps,
): Promise<void> {
  let rootAvailable: boolean | null = null; // lazily checked, once per visit
  for (const a of recorded) {
    const fn = a.fileinfo?.[0]?.filename;
    if (!fn || filesOnDisk.has(fn)) continue;
    const abs = path.join(dirPath, fn);
    if ((await statKind(abs)) !== 'absent') continue;
    rootAvailable ??= await libraryRootAvailable(root);
    if (!rootAvailable) {
      log.warn(
        { dir: dirPath, root },
        'sweep: removal candidates found but library root is unavailable — emitting no removals',
      );
      return;
    }
    await deps.handleEvent({ kind: 'removed', absPath: abs }, deps.folderId, root);
  }
}

/**
 * If the current generation's frontier is drained, start the next generation:
 * record the completed walk on the checkpoint and reseed the root dir. Returns
 * the generation to sweep next (unchanged if work remains).
 */
export async function advanceSweep(
  folderId: ObjectId,
  rootPath: string,
  gen: number,
): Promise<number> {
  if ((await frontier.remainingForGen(folderId, gen)) > 0) return gen;
  const nextGen = gen + 1;
  const fid = folderId.toHexString();
  const existing = await readCheckpoint(fid);
  await writeCheckpoint({
    folderId: fid,
    path: rootPath,
    lastWalkedAt: Date.now(),
    inflightIds: existing?.inflightIds ?? [],
    sweepGen: nextGen,
    updatedAt: Date.now(),
  });
  await frontier.seedRoot(folderId, rootPath, nextGen);
  return nextGen;
}

const LEASE_MS = 5 * 60 * 1000;

export interface SweepConfig {
  paused: boolean;
  sweepDirIntervalMs: number;
}

export interface SweeperLoopOpts {
  folderId: ObjectId;
  root: string;
  /** Starting sweep generation. Defaults to 1 for a fresh start. Pass the
   * value read from the checkpoint when rehydrating after a process restart
   * so the loop resumes the in-progress generation instead of re-walking
   * from gen 1. */
  startGen?: number;
  deps: ReconcileDeps;
  loadConfig: () => Promise<SweepConfig>;
  sleep?: (ms: number) => Promise<void>;
  onVisit?: (dirPath: string) => void;
}

export class SweeperLoop {
  private shuttingDown = false;
  private gen: number;
  private readonly o: SweeperLoopOpts;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: SweeperLoopOpts) {
    this.o = o;
    this.gen = o.startGen ?? 1;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  stop(): void {
    this.shuttingDown = true;
  }

  /** One claim→visit→pace cycle. Returns false when idle (nothing to do). */
  private async tick(cfg: SweepConfig): Promise<boolean> {
    const dir = await frontier.claimNextDir(this.o.folderId, this.gen, LEASE_MS);
    if (!dir) {
      this.gen = await advanceSweep(this.o.folderId, this.o.root, this.gen);
      return false;
    }
    this.o.onVisit?.(dir.dir_path);
    await visitDirectory(dir, this.o.root, this.o.deps);
    await this.sleep(cfg.sweepDirIntervalMs);
    return true;
  }

  /** Production loop: run until stop(); idle ⇒ sleep one interval and retry. */
  async run(): Promise<void> {
    while (!this.shuttingDown) {
      const cfg = await this.o.loadConfig();
      if (cfg.paused) {
        await this.sleep(Math.max(1000, cfg.sweepDirIntervalMs));
        continue;
      }
      const did = await this.tick(cfg);
      if (!did) await this.sleep(Math.max(1000, cfg.sweepDirIntervalMs));
    }
  }

  /** Test-only: drain until idle or a config flips paused. */
  async runUntilIdleOrPaused(): Promise<void> {
    for (;;) {
      const cfg = await this.o.loadConfig();
      if (cfg.paused) return;
      if (!(await this.tick(cfg))) return;
    }
  }
}
