import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, realpath, readdir, statfs } from '../fs/mirrored.ts';
import { safeWriteAllowed, registerRoot } from '../fs/root.ts';
import { fileHash, relativeBackupPath } from './inventory.ts';
import { latestManifests, readRemoteCatalog, readEntryPurge } from './catalog.ts';
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
async function validateRecoveryTarget(target: string): Promise<string> {
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
    entry.files.map((file) => ({ ...file, entryId: entry.entryId, libraryId: entry.libraryId })),
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
type RecoveryFile = ReturnType<typeof recoveryFiles>[number];
type RecoveryFileHandle = Awaited<ReturnType<typeof open>>;
async function assertNotPurged(
  provider: BackupProvider,
  entry: Pick<BackupManifest, 'libraryId' | 'entryId'>,
  signal: AbortSignal,
): Promise<void> {
  if (await readEntryPurge(provider, entry, signal))
    throw new Error('Backup was purged during recovery');
}
async function verifyOwnedFile(
  target: string,
  file: RecoveryFile,
  alreadyOwned: boolean,
): Promise<boolean> {
  try {
    const existing = await lstat(target);
    if (
      !alreadyOwned ||
      existing.isSymbolicLink() ||
      !existing.isFile() ||
      (await fileHash(target)) !== file.object.sha256
    )
      throw new Error('Recovery refuses to overwrite an existing file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}
async function writeRecoveryChunk(handle: RecoveryFileHandle, chunk: Uint8Array): Promise<void> {
  // FileHandle.write may write a partial buffer.
  for (let offset = 0; offset < chunk.length; ) {
    const written = await handle.write(chunk, offset, chunk.length - offset);
    if (!written.bytesWritten) throw new Error('Recovery disk write made no progress');
    offset += written.bytesWritten;
  }
}
async function downloadVerified(
  provider: BackupProvider,
  file: RecoveryFile,
  handle: RecoveryFileHandle,
  signal: AbortSignal,
): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  const reader = (await provider.download(file.object, signal)).getReader();
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
      await writeRecoveryChunk(handle, chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
  signal.throwIfAborted();
  if (bytes !== file.object.size || hash.digest('hex') !== file.object.sha256)
    throw new Error('Recovery checksum mismatch');
}
async function publishRecoveryFile(
  provider: BackupProvider,
  file: RecoveryFile,
  journal: RecoveryJournal,
  temp: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  await assertNotPurged(provider, file, signal);
  await assertRecoveryRoot(journal);
  signal.throwIfAborted();
  if ((await safeParent(journal.root, file.path)) !== target)
    throw new Error('Recovery parent changed');
  // The root is inode-pinned, but link() cannot pin parent directory names.
  // The owner must keep other processes from replacing target parents between
  // this check and publication; exclusive linking still prevents overwrites.
  await link(temp, target); // exclusive publication, never rename-overwrite
  const dir = await open(path.dirname(target), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
async function writeVerified(
  provider: BackupProvider,
  file: RecoveryFile,
  alreadyOwned: boolean,
  journal: RecoveryJournal,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await assertRecoveryRoot(journal);
  await assertNotPurged(provider, file, signal);
  const target = await safeParent(journal.root, file.path);
  if (await verifyOwnedFile(target, file, alreadyOwned)) return;
  const temp = path.join(
    journal.root,
    `.maple-recovery-${journal.jobId}-${crypto.randomUUID()}.tmp`,
  );
  const handle = await open(temp, 'wx', 0o600);
  try {
    await downloadVerified(provider, file, handle, signal);
    await handle.sync();
    await publishRecoveryFile(provider, file, journal, temp, target, signal);
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
async function recoveryCancellation(ctx: JobHandlerContext) {
  const controller = new AbortController();
  let checking = false;
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
  return { controller, poll, stop: () => clearInterval(timer) };
}
type RecoveryCancellation = Awaited<ReturnType<typeof recoveryCancellation>>;
async function initialRecoveryJournal(
  provider: BackupProvider,
  request: RecoveryRequest,
  root: string,
  jobId: string,
  source: RecoverySource,
  signal: AbortSignal,
): Promise<RecoveryJournal> {
  const stat = await lstat(root);
  return {
    version: 1,
    jobId,
    root,
    device: stat.dev,
    inode: stat.ino,
    source,
    selection: {
      includeTrash: request.includeTrash,
      ...(request.entryId ? { entryId: request.entryId, sequence: request.sequence } : {}),
    },
    entries: selected((await readRemoteCatalog(provider, signal)).entries, request),
    owned: [],
  };
}
async function assertRecoverySpace(root: string, files: RecoveryFile[]): Promise<void> {
  const bytes = files.reduce((sum, file) => sum + file.object.size, 0);
  const space = await statfs(root);
  if (bytes > space.bavail * space.bsize)
    throw new Error('Recovery directory has insufficient free space');
}
async function prepareRecovery(
  provider: BackupProvider,
  request: RecoveryRequest,
  ctx: JobHandlerContext,
  source: RecoverySource,
  root: string,
  signal: AbortSignal,
  saveCheckpoint: NonNullable<JobHandlerContext['saveCheckpoint']>,
) {
  signal.throwIfAborted();
  const jobId = ctx.jobId.toHexString();
  const selection = {
    includeTrash: request.includeTrash,
    ...(request.entryId ? { entryId: request.entryId, sequence: request.sequence } : {}),
  };
  const saved = await loadRecoveryJournal(root, jobId, source, selection);
  if (ctx.checkpoint && !saved) throw new Error('Recovery directory ownership journal is missing');
  await prepareRecoveryDirectory(root, jobId, Boolean(saved));
  const journal =
    saved ?? (await initialRecoveryJournal(provider, request, root, jobId, source, signal));
  const files = recoveryFiles(journal.entries);
  const gaps = await recoveryGaps(provider, files, signal);
  if (gaps.length) throw new Error(`Recovery backup coverage is incomplete: ${gaps.join('; ')}`);
  if (!saved) {
    await assertRecoverySpace(root, files);
    await saveRecoveryJournal(journal, true);
  }
  // Journal precedes the DB checkpoint. A crash in between resumes the same
  // immutable selection, even when the job ledger has no checkpoint yet.
  await saveCheckpoint({ targetPath: root, journal: jobId });
  return { journal, files };
}
async function downloadRecoveryFiles(
  provider: BackupProvider,
  journal: RecoveryJournal,
  files: RecoveryFile[],
  ctx: JobHandlerContext,
  cancellation: RecoveryCancellation,
  progress: { files: number },
) {
  for (const file of files) {
    await cancellation.poll();
    cancellation.controller.signal.throwIfAborted();
    const wasOwned = journal.owned.includes(file.path);
    if (!wasOwned) {
      journal.owned.push(file.path);
      await saveRecoveryJournal(journal);
    }
    await writeVerified(provider, file, wasOwned, journal, cancellation.controller.signal);
    await ctx.reportProgress(++progress.files, files.length);
  }
}
async function indexRecovery(
  provider: BackupProvider,
  journal: RecoveryJournal,
  cancellation: RecoveryCancellation,
) {
  const existing = await findFolderByPath(journal.root);
  const folderId =
    existing?._id ??
    (await registerFolder({
      path: journal.root,
      label: 'Recovered photos',
      slug: `recovered-${journal.jobId}`,
    }));
  registerRoot(journal.root);
  invalidateLibraryRoots();
  for (const entry of journal.entries) {
    await cancellation.poll();
    cancellation.controller.signal.throwIfAborted();
    await assertRecoveryRoot(journal);
    await assertNotPurged(provider, entry, cancellation.controller.signal);
    await indexRecoveredEntry(journal.root, folderId, entry);
  }
  return folderId;
}
export async function recoverBackup(
  provider: BackupProvider,
  request: RecoveryRequest,
  ctx: JobHandlerContext,
  source: RecoverySource,
) {
  const saveCheckpoint = ctx.saveCheckpoint;
  if (!saveCheckpoint) throw new Error('Recovery requires a durable job ledger');
  validateSelection(request);
  const root = await validateRecoveryTarget(request.targetPath);
  const cancellation = await recoveryCancellation(ctx);
  const progress = { files: 0 };
  try {
    const { journal, files } = await prepareRecovery(
      provider,
      request,
      ctx,
      source,
      root,
      cancellation.controller.signal,
      saveCheckpoint.bind(ctx),
    );
    await downloadRecoveryFiles(provider, journal, files, ctx, cancellation, progress);
    const folderId = await indexRecovery(provider, journal, cancellation);
    return {
      kind: 'done' as const,
      result: { files: progress.files, targetPath: root, libraryId: folderId.toHexString() },
    };
  } catch (error) {
    if (cancellation.controller.signal.reason instanceof RecoveryCancelled)
      return { kind: 'cancelled' as const, result: { files: progress.files, targetPath: root } };
    throw error;
  } finally {
    cancellation.stop();
  }
}
