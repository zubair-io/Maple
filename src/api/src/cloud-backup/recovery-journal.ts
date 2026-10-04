import * as path from 'node:path';
import { constants } from '../fs/mirrored.ts';
import { open, link, rename, unlink, lstat, readdir } from '../fs/mirrored.ts';
import { parseManifest } from './catalog.ts';
import type { BackupManifest } from './provider.ts';

export interface RecoverySource {
  destinationId: string;
  rootId: string;
  accountId: string;
}
export interface RecoverySelection {
  includeTrash: boolean;
  entryId?: string;
  sequence?: number;
}
export interface RecoveryJournal {
  version: 1;
  jobId: string;
  root: string;
  device: number;
  inode: number;
  source: RecoverySource;
  selection: RecoverySelection;
  entries: BackupManifest[];
  owned: string[];
}
const LIMIT = 64 * 1024 * 1024;
const markerPath = (root: string, jobId: string) =>
  path.join(root, `.maple-recovery-${jobId}.json`);
export async function assertRecoveryRoot(journal: RecoveryJournal): Promise<void> {
  const stat = await lstat(journal.root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== journal.device ||
    stat.ino !== journal.inode
  )
    throw new Error('Recovery directory ownership changed');
}
async function syncDirectory(root: string): Promise<void> {
  const handle = await open(root, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function loadRecoveryJournal(
  root: string,
  jobId: string,
  source: RecoverySource,
  selection: RecoverySelection,
): Promise<RecoveryJournal | null> {
  const handle = await open(
    markerPath(root, jobId),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return null;
  let journal: RecoveryJournal;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('Invalid recovery ownership journal');
    journal = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (
    journal.version !== 1 ||
    journal.root !== root ||
    journal.jobId !== jobId ||
    JSON.stringify(journal.source) !== JSON.stringify(source) ||
    JSON.stringify(journal.selection) !== JSON.stringify(selection) ||
    !Array.isArray(journal.entries) ||
    !Array.isArray(journal.owned) ||
    !journal.owned.every((name) => typeof name === 'string')
  )
    throw new Error('Recovery source or selection changed');
  journal.entries = journal.entries.map(parseManifest);
  const names = new Set(journal.entries.flatMap((entry) => entry.files.map((file) => file.path)));
  if (journal.owned.some((name) => !names.has(name)))
    throw new Error('Invalid recovery file ownership');
  await assertRecoveryRoot(journal);
  return journal;
}
export async function saveRecoveryJournal(
  journal: RecoveryJournal,
  initial = false,
): Promise<void> {
  await assertRecoveryRoot(journal);
  const marker = markerPath(journal.root, journal.jobId);
  const pending = `${marker}.pending`;
  const encoded = JSON.stringify(journal);
  if (Buffer.byteLength(encoded) > LIMIT)
    throw new Error('Recovery selection exceeds the durable journal limit');
  const handle = await open(pending, 'wx', 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertRecoveryRoot(journal);
    if (initial) await link(pending, marker);
    else await rename(pending, marker);
    await syncDirectory(journal.root);
  } finally {
    await unlink(pending).catch(() => {});
  }
}
export async function prepareRecoveryDirectory(
  root: string,
  jobId: string,
  resuming: boolean,
): Promise<void> {
  // Only this unpredictable job's internal files may be removed after a crash.
  const pending = `${markerPath(root, jobId)}.pending`;
  const leftovers = (await readdir(root)).filter(
    (name) =>
      name === path.basename(pending) ||
      (resuming && name.startsWith(`.maple-recovery-${jobId}-`) && name.endsWith('.tmp')),
  );
  for (const name of leftovers) {
    const absolute = path.join(root, name);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Recovery temporary file ownership changed');
    await unlink(absolute);
  }
  if (!resuming && (await readdir(root)).length)
    throw new Error('Choose an empty recovery directory');
}
