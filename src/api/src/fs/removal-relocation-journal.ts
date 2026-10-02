/** #1472: durable replacement recovery; recovery never deletes a source. */
import * as fs from './mirrored.ts';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { removalRecords } from './removal-records.ts';
import { listPairedSidecars } from './xmp-conflict.ts';
import { removalRelocationLease } from './removal-relocation-lease.ts';
import { isWithinRoot } from './root.ts';

interface JournalFile {
  name: string;
  previous: string | null;
  incoming: string | null;
  backup: string | null;
}
interface Journal {
  schema: 1;
  id: string;
  targetName: string;
  source: string;
  sources: { path: string; digest: string }[];
  files: JournalFile[];
}
export interface RemovalPublication {
  target: string;
  source?: string;
  bytes?: Buffer<ArrayBuffer>;
}

export function removalJournalPath(target: string) {
  return join(dirname(target), `.${basename(target)}.removal-relocation.json`);
}

export async function syncRemovalDirectory(directory: string) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function removalFileDigest(path: string): Promise<string | null> {
  const info = await fs.lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Removal recovery file is not a regular file: ${path}`);
  const file = await fs.open(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

const bytesDigest = (bytes: Buffer<ArrayBuffer>) =>
  createHash('sha256').update(bytes).digest('hex');
const component = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  name !== '.' &&
  name !== '..' &&
  basename(name) === name &&
  !name.includes('\\') &&
  !name.includes('\0');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reserved = (target: string, name: string) =>
  name === basename(removalJournalPath(target)) ||
  name === `.${basename(target)}.relocation.lock` ||
  name.endsWith('.xmp.lock');

async function readJournal(target: string): Promise<Journal | null> {
  const path = removalJournalPath(target);
  if ((await removalFileDigest(path)) === null) return null;
  const record = JSON.parse(await fs.readFile(path, 'utf8')) as Journal;
  if (
    record.schema !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.id) ||
    record.targetName !== basename(target) ||
    !isAbsolute(record.source) ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.sources) ||
    !record.sources.some((value) => value.path === record.source) ||
    record.sources.some((value) => !isAbsolute(value.path) || !digest(value.digest)) ||
    !record.files.some((value) => value.name === basename(target) && digest(value.incoming)) ||
    record.files.find((value) => value.name === basename(target))?.incoming !==
      record.sources.find((value) => value.path === record.source)?.digest ||
    new Set(record.files.map((value) => value.name)).size !== record.files.length ||
    record.files.some(
      (value) =>
        !component(value.name) ||
        reserved(target, value.name) ||
        (value.previous !== null && !digest(value.previous)) ||
        (value.incoming !== null && !digest(value.incoming)) ||
        (value.backup === null
          ? value.previous !== null
          : !component(value.backup) ||
            !value.previous ||
            value.backup !== `${value.name}.tmp.${record.id}.rollback`),
    )
  )
    throw new Error('Unrecognized removal relocation recovery journal');
  return record;
}

async function verifyAssets(raw: string) {
  for (const path of await listPairedSidecars(raw)) {
    const records = removalRecords(await fs.readFile(path, 'utf8'));
    if (records !== null) await ffiPool().verifyRemovalAssets(raw, records);
  }
}

async function cleanup(target: string, record: Journal) {
  const currentRecord = await readJournal(target);
  if (JSON.stringify(currentRecord) !== JSON.stringify(record))
    throw new Error('Removal recovery journal changed; evidence retained');
  // Validate the whole backup set first; partial cleanup is restartable.
  for (const value of record.files) {
    if (!value.backup) continue;
    const current = await removalFileDigest(join(dirname(target), value.backup));
    if (current !== null && current !== value.previous)
      throw new Error('Removal recovery backup was changed; evidence retained');
  }
  for (const value of record.files)
    if (value.backup) await fs.rm(join(dirname(target), value.backup), { force: true });
  await fs.unlink(removalJournalPath(target));
  await syncRemovalDirectory(dirname(target));
}

async function restore(target: string, record: Journal) {
  const sourcePath = await fs.realpath(record.source);
  const destinationPath = await fs.realpath(target).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (sourcePath === destinationPath)
    throw new Error('Recovery source must be a separate retained incoming original');
  for (const value of record.sources)
    if ((await removalFileDigest(value.path)) !== value.digest)
      throw new Error('Recovery requires the intact incoming edit at its original source');
  await verifyAssets(record.source);
  const sidecars = await listPairedSidecars(target);
  if (sidecars.some((path) => !record.files.some((value) => value.name === basename(path))))
    throw new Error('Destination has a later sidecar; recovery evidence retained');
  for (const value of record.files) {
    const current = await removalFileDigest(join(dirname(target), value.name));
    if (current !== null && current !== value.previous && current !== value.incoming)
      throw new Error('Destination changed after relocation; recovery evidence retained');
    if (
      value.backup &&
      (await removalFileDigest(join(dirname(target), value.backup))) !== value.previous
    )
      throw new Error('Removal recovery backup is missing or changed');
  }
  for (const value of record.files) {
    const path = join(dirname(target), value.name);
    if (value.backup) {
      const temp = `${path}.tmp.${randomUUID()}`;
      try {
        await fs.copyFile(join(dirname(target), value.backup), temp);
        if ((await removalFileDigest(temp)) !== value.previous)
          throw new Error('Removal recovery copy differs from its backup');
        const handle = await fs.open(temp, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, path);
      } finally {
        await fs.rm(temp, { force: true });
      }
    } else await fs.rm(path, { force: true });
    await syncRemovalDirectory(dirname(target));
  }
}

/** Caller holds the lease when publishing or recovering. */
export async function recoverRemovalUnderLease(target: string) {
  const record = await readJournal(target);
  if (!record) return;
  const current = await Promise.all(
    record.files.map((value) => removalFileDigest(join(dirname(target), value.name))),
  );
  const complete = current.every((value, index) => value === record.files[index].incoming);
  const previous = current.every((value, index) => value === record.files[index].previous);
  if (complete) {
    const sidecars = await listPairedSidecars(target);
    if (sidecars.some((path) => !record.files.some((value) => value.name === basename(path))))
      throw new Error('Destination has a later sidecar; recovery evidence retained');
    await verifyAssets(target);
  } else if (!previous) await restore(target, record);
  await cleanup(target, record);
}

/** A journal can appear between recovery and acquisition of a new request's
 * lease. Retry with the journal's complete source+destination lease rather than
 * restoring while holding this new request's different source lock. */
export async function assertRemovalRecovered(target: string) {
  if (await readJournal(target))
    throw new Error('Photo has an interrupted relocation; retry recovery before changing it');
}

/** Run before collision resolution: an abandoned partial file is not an occupant. */
export async function recoverRemovalRelocation(target: string, sourceRoots?: readonly string[]) {
  const record = await readJournal(target);
  if (!record) return;
  const sourceExists = await fs.lstat(record.source).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  // Passive discovery must not create coordination files at a source named
  // by an on-disk journal outside the server's registered libraries.
  if (sourceRoots && sourceExists) {
    const source = await fs.realpath(record.source);
    if (!sourceRoots.some((root) => isWithinRoot(root, source)))
      throw new Error('Removal recovery source is outside registered libraries; evidence retained');
  }
  const lease = await removalRelocationLease(
    sourceExists?.isFile() && !sourceExists.isSymbolicLink() ? record.source : target,
    target,
  );
  try {
    await recoverRemovalUnderLease(target);
  } finally {
    await lease.release();
  }
}

export async function createRemovalJournal(
  source: string,
  target: string,
  sources: string[],
  publications: RemovalPublication[],
) {
  if (await readJournal(target)) throw new Error('Removal relocation still needs recovery');
  const id = randomUUID();
  const record: Journal = {
    schema: 1,
    id,
    targetName: basename(target),
    source,
    sources: await Promise.all(
      [...new Set(sources)].map(async (path) => {
        const value = await removalFileDigest(path);
        if (!value) throw new Error('Removal source disappeared before publication');
        return { path, digest: value };
      }),
    ),
    files: [],
  };
  for (const publication of publications) {
    if (
      dirname(publication.target) !== dirname(target) ||
      !component(basename(publication.target)) ||
      reserved(target, basename(publication.target))
    )
      throw new Error('Removal publication must stay in the destination directory');
    const previous = await removalFileDigest(publication.target);
    const incoming = publication.bytes
      ? bytesDigest(publication.bytes)
      : publication.source
        ? await removalFileDigest(publication.source)
        : null;
    if (publication.source && !incoming) throw new Error('Removal publication source disappeared');
    const backup = previous ? `${basename(publication.target)}.tmp.${id}.rollback` : null;
    if (backup) {
      const path = join(dirname(target), backup);
      await fs.copyFile(publication.target, path, fs.constants.COPYFILE_EXCL);
      if ((await removalFileDigest(path)) !== previous)
        throw new Error('Removal rollback copy verification failed');
      const handle = await fs.open(path, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncRemovalDirectory(dirname(target));
    }
    record.files.push({ name: basename(publication.target), previous, incoming, backup });
  }
  if (new Set(record.files.map((value) => value.name)).size !== record.files.length)
    throw new Error('Removal publications overlap');
  const journal = removalJournalPath(target);
  const temp = `${journal}.tmp.${id}`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temp, journal);
    await syncRemovalDirectory(dirname(target));
  } finally {
    await fs.rm(temp, { force: true });
  }
  return {
    finish: () => cleanup(target, record),
    rollback: async () => {
      await restore(target, record);
      await cleanup(target, record);
    },
  };
}
