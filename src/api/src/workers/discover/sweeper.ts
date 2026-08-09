/**
 * Discover reconciliation sweep — the chokidar replacement. Walks one directory
 * per call: enqueues subdirs onto the frontier, emits created/modified for new
 * or changed images via the injected `handleEvent`, and emits removed for
 * assets recorded in this dir whose file is gone (per-directory diff — no
 * whole-tree state, no per-asset "seen" write).
 */
import path from 'node:path';
import { promises as fs, type Dirent } from 'node:fs';
import type { ObjectId, WithId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { SUPPORTED_EXTS, toPosixRelDir } from './types.ts';
import type { WatchEvent } from './types.ts';
import { DUPLICATES_DIR_NAME } from '../../fs/duplicates.ts';
import * as frontier from './frontier.repo.ts';
import type { FrontierDir } from './frontier.repo.ts';
import { readCheckpoint, writeCheckpoint } from '../../indexer/checkpoint.ts';
import { libraryRootAvailable, statKind } from '../missing-reaper.helpers.ts';
import { child } from '../../log.ts';
import {
  reconcileRenamesInDirectory,
  type MissingFileCandidate,
  type NewFileCandidate,
} from './rename-reconcile.ts';
import type { AssetDoc, FileInfo } from '../../db/schema.ts';

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

  const { subdirs, filesOnDisk } = partitionEntries(entries, dir.dir_path);

  // Recorded files not seen in the listing → candidate removals. A missing
  // entry is NOT trusted on its own: a `fs.readdir` can succeed yet return an
  // incomplete set on a network share (SMB blip). Re-stat each candidate and
  // only treat it as removed on a genuine ENOENT. A present file or an
  // inconclusive stat error (EACCES/EIO/timeout) is left for the next sweep,
  // so a truncated listing can never mass-tag present files `missing_since`.
  // Even a confirmed per-file ENOENT is not enough when the LIBRARY ROOT is
  // unavailable (#2171) — see `confirmMissingCandidates`'s own doc comment.
  const { newCandidates, missingCandidates } = await loadDirectoryCandidates(
    root,
    dir.dir_path,
    folderId,
    filesOnDisk,
  );

  // Rename reconciliation (#2655): pair up missing/new candidates that share
  // a cheap fingerprint (size + EXIF capture time + camera serial) BEFORE
  // falling back to the ordinary created/removed treatment — a reconciled
  // pair is excluded from both loops below, so it never becomes "new asset,
  // orphaned sidecar" + "missing, eventually reaped".
  const reconciled = await reconcileRenamesInDirectory(
    newCandidates,
    missingCandidates,
    root,
    folderId,
  );

  await emitUnreconciledEvents(newCandidates, missingCandidates, reconciled, root, deps);

  await frontier.enqueueDirs(folderId, subdirs, dir.sweep_gen);
  await frontier.completeDir(dir._id);
}

/** Splits a directory listing into subdirectories to descend into and
 * supported image/video files present on disk (filename → absPath). Skips
 * the DeDuplicate quarantine, every dotdir/dotfile (in particular `.maple/`
 * — see the inline comment below), and anything whose extension isn't in
 * `SUPPORTED_EXTS`. */
function partitionEntries(
  entries: readonly Dirent[],
  dirPath: string,
): { subdirs: string[]; filesOnDisk: Map<string, string> } {
  const subdirs: string[] = [];
  const filesOnDisk = new Map<string, string>(); // filename -> absPath (images only)

  for (const ent of entries) {
    const abs = path.join(dirPath, ent.name);
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
      if (ent.name !== DUPLICATES_DIR_NAME && !ent.name.startsWith('.')) subdirs.push(abs);
      continue;
    }
    // Skip non-files, non-images, and dotfiles (e.g. `.DS_Store`, AppleDouble
    // `._foo.jpg` resource forks — their extension matches but their content
    // doesn't).
    if (ent.isFile() && isSupported(ent.name) && !ent.name.startsWith('.')) {
      filesOnDisk.set(ent.name, abs);
    }
  }
  return { subdirs, filesOnDisk };
}

type RecordedAsset = Pick<WithId<AssetDoc>, '_id' | 'size' | 'exif'> & {
  fileinfo: FileInfo[];
};

/** ONE indexed read per dir: the non-deleted assets recorded directly in it.
 * Drives BOTH "what's new" and "what's gone" — so writes happen only on real
 * changes, never a per-file upsert storm. `size`/`exif` ride along on the
 * same read (no extra round-trip) because the rename-reconcile pass needs
 * them to fingerprint a candidate rename without re-reading the
 * (already-missing) old file. Returns the unrecorded on-disk files and the
 * confirmed-absent recorded entries — `visitDirectory`'s two candidate
 * pools for reconciliation (and, for whatever reconciliation declines,
 * the ordinary created/removed events). */
async function loadDirectoryCandidates(
  root: string,
  dirPath: string,
  folderId: ObjectId,
  filesOnDisk: ReadonlyMap<string, string>,
): Promise<{ newCandidates: NewFileCandidate[]; missingCandidates: MissingFileCandidate[] }> {
  const rel = toPosixRelDir(path.relative(root, dirPath));
  const coll = await assetsCollection();
  const recorded = (await coll
    .find(
      { deleted_at: null, fileinfo: { $elemMatch: { library_id: folderId, path: rel } } },
      { projection: { 'fileinfo.$': 1, size: 1, exif: 1 } },
    )
    .toArray()) as RecordedAsset[];
  const recordedNames = new Set<string>();
  for (const a of recorded) {
    const fn = a.fileinfo?.[0]?.filename;
    if (fn) recordedNames.add(fn);
  }

  const newCandidates: NewFileCandidate[] = [];
  for (const [name, abs] of filesOnDisk) {
    if (!recordedNames.has(name)) newCandidates.push({ filename: name, absPath: abs });
  }

  const missingCandidates = await confirmMissingCandidates(recorded, filesOnDisk, dirPath, root);
  return { newCandidates, missingCandidates };
}

/** Emits the ordinary `created`/`removed` events for every candidate the
 * rename-reconcile pass did NOT resolve — a reconciled candidate must never
 * also flow through here (it already got its own `update` event). */
async function emitUnreconciledEvents(
  newCandidates: readonly NewFileCandidate[],
  missingCandidates: readonly MissingFileCandidate[],
  reconciled: {
    reconciledNewFilenames: ReadonlySet<string>;
    reconciledMissingFilenames: ReadonlySet<string>;
  },
  root: string,
  deps: ReconcileDeps,
): Promise<void> {
  for (const c of newCandidates) {
    if (reconciled.reconciledNewFilenames.has(c.filename)) continue;
    await deps.handleEvent({ kind: 'created', absPath: c.absPath }, deps.folderId, root);
  }
  for (const m of missingCandidates) {
    if (reconciled.reconciledMissingFilenames.has(m.filename)) continue;
    await deps.handleEvent({ kind: 'removed', absPath: m.absPath }, deps.folderId, root);
  }
}

/** The removal-confirmation pass of `visitDirectory`: re-stat each
 * recorded-but-unlisted candidate and collect it only on a confirmed ENOENT
 * under an available library root. The root check is lazy — one
 * `libraryRootAvailable` call per visit, and only once a candidate has
 * actually confirmed absent; a not-available root aborts with NO candidates
 * at all (mirrors the prior emit-immediately behaviour exactly — see
 * `sweeper.test.ts`'s unmounted-mountpoint case). */
async function confirmMissingCandidates(
  recorded: RecordedAsset[],
  filesOnDisk: ReadonlyMap<string, string>,
  dirPath: string,
  root: string,
): Promise<MissingFileCandidate[]> {
  const out: MissingFileCandidate[] = [];
  let rootAvailable: boolean | null = null; // lazily checked, once per visit
  for (const a of recorded) {
    const entry = a.fileinfo?.[0];
    if (!entry || filesOnDisk.has(entry.filename)) continue;
    const abs = path.join(dirPath, entry.filename);
    if ((await statKind(abs)) !== 'absent') continue;
    rootAvailable ??= await libraryRootAvailable(root);
    if (!rootAvailable) {
      log.warn(
        { dir: dirPath, root },
        'sweep: removal candidates found but library root is unavailable — confirming none',
      );
      return [];
    }
    out.push({
      docId: a._id,
      fileinfo: entry,
      filename: entry.filename,
      absPath: abs,
      size: a.size,
      exif: a.exif,
    });
  }
  return out;
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
