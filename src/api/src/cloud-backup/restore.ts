import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, realpath, readdir, statfs } from '../fs/mirrored.ts';
import { safeWriteAllowed, registerRoot } from '../fs/root.ts';
import { fileHash, relativeBackupPath } from './inventory.ts';
import { latestManifests, readRemoteCatalog, readPurges } from './catalog.ts';
import type { BackupProvider, BackupManifest } from './provider.ts';
import type { JobHandlerContext } from '../job-runner/handlers/index.ts';
import { findFolderByPath, registerFolder } from '../db/repos/folders.repo.ts';
import { indexRecoveredEntry } from './recovery-index.ts';
import {
  assertRecoveryRoot,
  loadRecoveryJournal,
  saveRecoveryJournal,
  prepareRecoveryDirectory,
  type RecoveryJournal,
  type RecoverySource,
} from './recovery-journal.ts';

import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

export interface RecoveryRequest {
  targetPath: string;
  includeTrash: boolean;
  entryId?: string;
  sequence?: number;
}
export async function validateRecoveryTarget(target: string): Promise<string> {
  if (!path.isAbsolute(target)) throw new Error('Recovery requires an absolute empty directory');
  const allowed = await safeWriteAllowed(path.join(target, '.maple-recovery-check'));
  if (!allowed.ok) throw new Error('Recovery directory is outside allowed server roots');
  const canonical = await realpath(target);
  if ((await lstat(target)).isSymbolicLink() || !(await lstat(canonical)).isDirectory())
    throw new Error('Recovery target must be a directory, not a symlink');
  return canonical;
}
function selected(entries: BackupManifest[], request: RecoveryRequest): BackupManifest[] {
  validateSelection(request);
  const versions = latestManifests(
    entries,
    request.entryId && request.sequence
      ? { entryId: request.entryId, sequence: request.sequence }
      : undefined,
  );
  return versions.filter((entry) => request.includeTrash || entry.state === 'active');
}
function recoveryFiles(entries: BackupManifest[]) {
  const files = entries.flatMap((entry) =>
    entry.files.map((file) => ({ ...file, entryId: entry.entryId })),
  );
  const names = new Set<string>();
  for (const file of files) {
    relativeBackupPath(file.path);
    const name = file.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (
      name.split('/')[0]!.startsWith('.maple-recovery-') ||
      (name.startsWith('.maple/') && !file.path.startsWith('.maple/trash/'))
    )
      throw new Error('Catalog contains a reserved recovery path');
    if (names.has(name)) throw new Error('Recovery paths collide; restore entries separately');
    names.add(name);
  }
  return files;
}
async function recoveryGaps(
  provider: BackupProvider,
  files: ReturnType<typeof recoveryFiles>,
  signal?: AbortSignal,
): Promise<string[]> {
  const gaps: string[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    try {
      const actual = await provider.inspect(file.object.key, signal, file.object.locator);
      if (!actual) gaps.push(`${file.path}: backup object is missing or outside the backup root`);
      else if (
        actual.key !== file.object.key ||
        actual.locator !== file.object.locator ||
        actual.size !== file.object.size ||
        actual.sha256 !== file.object.sha256
      )
        gaps.push(`${file.path}: backup object identity changed`);
    } catch {
      signal?.throwIfAborted();
      gaps.push(`${file.path}: backup object could not be verified`);
    }
  }
  return gaps;
}
export async function recoveryPreview(provider: BackupProvider, request: RecoveryRequest) {
  const target = await validateRecoveryTarget(request.targetPath);
  if ((await readdir(target)).length) throw new Error('Choose an empty recovery directory');
  const catalog = await readRemoteCatalog(provider);
  const entries = selected(catalog.entries, request);
  const files = recoveryFiles(entries);
  const bytes = files.reduce((sum, file) => sum + file.object.size, 0);
  const space = await statfs(target);
  if (bytes > space.bavail * space.bsize)
    throw new Error('Recovery directory has insufficient free space');
  const gaps = await recoveryGaps(provider, files);
  return { files: files.length, bytes, entries: entries.length, gaps };
}
async function safeParent(root: string, relative: string): Promise<string> {
  const segments = relativeBackupPath(relative).split('/');
  for (const [index] of segments.slice(0, -1).entries()) {
    const dir = path.join(root, ...segments.slice(0, index + 1));
    await mkdir(dir, { recursive: false }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (
      (await lstat(dir)).isSymbolicLink() ||
      !(await lstat(dir)).isDirectory() ||
      (await realpath(dir)) !== dir
    )
      throw new Error('Recovery path contains a symlink');
  }
  return path.join(root, ...segments);
}
async function writeVerified(
  provider: BackupProvider,
  file: ReturnType<typeof recoveryFiles>[number],
  root: string,
  alreadyOwned: boolean,
  journal: RecoveryJournal,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await assertRecoveryRoot(journal);
  if ((await readPurges(provider, signal)).some((p) => p.entryId === file.entryId))
    throw new Error('Backup was purged during recovery');
  const target = await safeParent(root, file.path);
  try {
    const existing = await lstat(target);
    if (
      !alreadyOwned ||
      existing.isSymbolicLink() ||
      !existing.isFile() ||
      (await fileHash(target)) !== file.object.sha256
    )
      throw new Error('Recovery refuses to overwrite an existing file');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = path.join(root, `.maple-recovery-${journal.jobId}-${crypto.randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const stream = await provider.download(file.object, signal);
    const reader = stream.getReader();
    const cancel = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value: chunk } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        bytes += chunk.length;
        if (bytes > file.object.size) throw new Error('Recovery download exceeds expected size');
        hash.update(chunk);
        // FileHandle.write may write a partial buffer.
        for (let offset = 0; offset < chunk.length; ) {
          const written = await handle.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) throw new Error('Recovery disk write made no progress');
          offset += written.bytesWritten;
        }
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    if (bytes !== file.object.size || hash.digest('hex') !== file.object.sha256)
      throw new Error('Recovery checksum mismatch');
    await handle.sync();
    if ((await readPurges(provider, signal)).some((p) => p.entryId === file.entryId))
      throw new Error('Backup was purged during recovery');
    await assertRecoveryRoot(journal);
    signal.throwIfAborted();
    if ((await safeParent(root, file.path)) !== target) throw new Error('Recovery parent changed');
    await link(temp, target); // exclusive publication, never rename-overwrite
    const dir = await open(path.dirname(target), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await handle.close();
    await unlink(temp).catch(() => {});
  }
}
class RecoveryCancelled extends Error {}
function validateSelection(request: RecoveryRequest) {
  if (
    (request.entryId === undefined) !== (request.sequence === undefined) ||
    (request.sequence !== undefined &&
      (!Number.isSafeInteger(request.sequence) || request.sequence < 1))
  )
    throw new Error('Invalid recovery version selection');
}
export async function recoverBackup(
  provider: BackupProvider,
  request: RecoveryRequest,
  ctx: JobHandlerContext,
  source: RecoverySource,
) {
  if (!ctx.saveCheckpoint) throw new Error('Recovery requires a durable job ledger');
  validateSelection(request);
  const root = await validateRecoveryTarget(request.targetPath);
  const selection = {
    includeTrash: request.includeTrash,
    ...(request.entryId ? { entryId: request.entryId, sequence: request.sequence } : {}),
  };
  const jobId = ctx.jobId.toHexString();
  const controller = new AbortController();
  let checking = false;
  let current = 0;
  const poll = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      if (await ctx.shouldCancel()) controller.abort(new RecoveryCancelled('Recovery cancelled'));
    } catch (error) {
      controller.abort(error);
    } finally {
      checking = false;
    }
  };
  await poll();
  const timer = setInterval(() => {
    void poll();
  }, 100);
  try {
    controller.signal.throwIfAborted();
    const saved = await loadRecoveryJournal(root, jobId, source, selection);
    if (ctx.checkpoint && !saved)
      throw new Error('Recovery directory ownership journal is missing');
    await prepareRecoveryDirectory(root, jobId, Boolean(saved));
    const stat = await lstat(root);
    const journal = saved ?? {
      version: 1 as const,
      jobId,
      root,
      device: stat.dev,
      inode: stat.ino,
      source,
      selection,
      entries: selected((await readRemoteCatalog(provider, controller.signal)).entries, request),
      owned: [],
    };
    const files = recoveryFiles(journal.entries);
    const gaps = await recoveryGaps(provider, files, controller.signal);
    if (gaps.length) throw new Error(`Recovery backup coverage is incomplete: ${gaps.join('; ')}`);
    if (!saved) {
      const bytes = files.reduce((sum, file) => sum + file.object.size, 0);
      const space = await statfs(root);
      if (bytes > space.bavail * space.bsize)
        throw new Error('Recovery directory has insufficient free space');
      await saveRecoveryJournal(journal, true);
    }
    // Journal precedes the DB checkpoint. A crash in between resumes the same
    // immutable selection, even when the job ledger has no checkpoint yet.
    await ctx.saveCheckpoint({ targetPath: root, journal: jobId });
    for (const file of files) {
      await poll();
      controller.signal.throwIfAborted();
      const wasOwned = journal.owned.includes(file.path);
      if (!wasOwned) {
        journal.owned.push(file.path);
        await saveRecoveryJournal(journal);
      }
      await writeVerified(provider, file, root, wasOwned, journal, controller.signal);
      await ctx.reportProgress(++current, files.length);
    }
    const existing = await findFolderByPath(root);
    const folderId =
      existing?._id ??
      (await registerFolder({ path: root, label: 'Recovered photos', slug: `recovered-${jobId}` }));
    registerRoot(root);
    invalidateLibraryRoots();
    for (const entry of journal.entries) {
      await poll();
      controller.signal.throwIfAborted();
      await assertRecoveryRoot(journal);
      if ((await readPurges(provider, controller.signal)).some((p) => p.entryId === entry.entryId))
        throw new Error('Backup was purged during recovery');
      await indexRecoveredEntry(root, folderId, entry);
    }
    return {
      kind: 'done' as const,
      result: { files: current, targetPath: root, libraryId: folderId.toHexString() },
    };
  } catch (error) {
    if (controller.signal.reason instanceof RecoveryCancelled)
      return { kind: 'cancelled' as const, result: { files: current, targetPath: root } };
    throw error;
  } finally {
    clearInterval(timer);
  }
}
