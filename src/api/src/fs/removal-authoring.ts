/** #3984 / #1472: durable Self Hosted authoring, separate from inference. */
import * as fs from './mirrored.ts';
import { dirname, join, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { RAW_EXTENSIONS } from '../indexer/media-types.ts';
import { safeWriteAllowed } from './root.ts';
import { xmpSidecarPath } from './xmp.ts';
import { removalRecords } from './removal-records.ts';
import { withSidecarMutationLease } from './sidecar-mutation-lease.ts';
import { writeSidecarAtomic } from './sidecar-io.ts';
import { syncRemovalDirectory } from './removal-relocation-journal.ts';

export class RemovalAuthoringError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(status: number, message: string): never {
  throw new RemovalAuthoringError(status, message);
}
const revision = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

async function info(path: string) {
  return fs.lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
}

async function authorizeRaw(raw: string) {
  if (!RAW_EXTENSIONS.has(extname(raw).slice(1).toLowerCase()))
    fail(415, 'Removal authoring requires a RAW file');
  for (const path of [raw, xmpSidecarPath(raw)]) {
    const allowed = await safeWriteAllowed(path);
    if (!allowed.ok) fail(403, allowed.error ?? 'Path is outside registered libraries');
  }
  const source = await fs.stat(raw).catch((error: unknown) => {
    if (missing(error)) fail(404, 'Removal source is unavailable');
    throw error;
  });
  if (!source.isFile()) fail(400, 'Removal source is not a file');
}

export async function removalSidecarSnapshot(raw: string) {
  await authorizeRaw(raw);
  const path = xmpSidecarPath(raw);
  const current = await info(path);
  if (!current) return { revision: 'missing', xml: '' };
  if (!current.isFile() || current.isSymbolicLink()) fail(409, 'Unsafe XMP sidecar');
  const bytes = await fs.readFile(path);
  return {
    revision: revision(bytes),
    xml: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  };
}

async function assetDirectory(raw: string, create: boolean) {
  await authorizeRaw(raw);
  const maple = join(dirname(raw), '.maple');
  const assets = join(maple, 'inpaint');
  for (const path of [maple, assets]) {
    const existing = await info(path);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      fail(409, 'Removal companion directory must not be a link or file');
    if (!existing && create) {
      await fs.mkdir(path).catch((error: unknown) => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
          throw error;
      });
      const created = await fs.lstat(path);
      if (!created.isDirectory() || created.isSymbolicLink())
        fail(409, 'Removal companion directory changed during creation');
      await syncRemovalDirectory(dirname(path));
    }
  }
  return assets;
}

function assetName(name: string) {
  // Path confinement only: Rust validates the digest, codec and dimensions.
  if (!/^[a-f0-9]{64}\.(mask|f16)$/.test(name)) fail(400, 'Invalid removal companion name');
}

async function validateAsset(path: string, name: string) {
  const current = await info(path);
  if (!current) fail(404, 'Removal companion is unavailable');
  if (!current.isFile() || current.isSymbolicLink()) fail(409, 'Unsafe removal companion');
  await ffiPool()
    .verifyRemovalAsset(path, name)
    .catch((error: unknown) => fail(422, error instanceof Error ? error.message : String(error)));
}

export async function readRemovalCompanion(raw: string, name: string) {
  assetName(name);
  const path = join(await assetDirectory(raw, false), name);
  const current = await info(path);
  if (!current) fail(404, 'Removal companion is unavailable');
  if (!current.isFile() || current.isSymbolicLink()) fail(409, 'Unsafe removal companion');
  const bytes = await fs.readFile(path);
  await validateAsset(path, name);
  if (!(await fs.readFile(path)).equals(bytes)) fail(409, 'Removal companion changed during read');
  return bytes;
}

function requirePublicationLease() {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    fail(503, 'Removal authoring requires a POSIX filesystem lease');
}

export async function publishRemovalCompanion(raw: string, name: string, bytes: Uint8Array) {
  assetName(name);
  requirePublicationLease();
  await authorizeRaw(raw);
  return withSidecarMutationLease(raw, async () => {
    const path = join(await assetDirectory(raw, true), name);
    const temp = `${path}.tmp.${randomUUID()}`;
    try {
      const handle = await fs.open(temp, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await validateAsset(temp, name);
      await fs.link(temp, path).catch((error: unknown) => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
          throw error;
      });
      await validateAsset(path, name);
      if (!(await fs.readFile(path)).equals(Buffer.from(bytes)))
        fail(409, 'Existing removal companion differs; retained without replacement');
      await syncRemovalDirectory(dirname(path));
    } finally {
      await fs.rm(temp, { force: true });
    }
    return { name };
  });
}

function validatedRecords(xml: string) {
  try {
    new SaxesParser({ xmlns: true }).write(xml).close();
    return removalRecords(xml) ?? '[]';
  } catch (error) {
    return fail(422, `Invalid XMP: ${String(error)}`);
  }
}

export interface RemovalSidecarCommit {
  expectedRevision: string;
  expectedRecords: string;
  xml: string;
}

async function verifyStack(raw: string, prior: string, records: string) {
  try {
    // Verify old source identity without requiring lost old assets: Clear is
    // a recovery operation. Every asset in the new stack must be available.
    const source = await ffiPool().verifyRemovalSource(raw, prior);
    const next = await ffiPool().verifyRemovalSource(raw, records);
    if (source.originalDigest !== next.originalDigest) fail(409, 'Original RAW changed');
    for (const name of next.names) await readRemovalCompanion(raw, name);
    const confirmed = await ffiPool().verifyRemovalAssets(raw, records);
    if (source.originalDigest !== confirmed.originalDigest) fail(409, 'Original RAW changed');
  } catch (error) {
    if (error instanceof RemovalAuthoringError) throw error;
    fail(422, error instanceof Error ? error.message : String(error));
  }
}

export async function commitRemovalSidecar(raw: string, request: RemovalSidecarCommit) {
  requirePublicationLease();
  await authorizeRaw(raw);
  const records = validatedRecords(request.xml);
  return withSidecarMutationLease(raw, async () => {
    const current = await removalSidecarSnapshot(raw);
    // A lost HTTP acknowledgement can be retried without overwriting later
    // edits. Only the exact already-published document satisfies the retry.
    if (current.revision === revision(Buffer.from(request.xml))) {
      await verifyStack(raw, request.expectedRecords, records);
      if ((await removalSidecarSnapshot(raw)).revision !== current.revision)
        fail(409, 'XMP changed during removal retry validation');
      return current;
    }
    if (current.revision !== request.expectedRevision)
      fail(409, 'XMP changed since this removal edit opened; reload before saving');
    const prior = current.xml ? validatedRecords(current.xml) : '[]';
    if (prior !== request.expectedRecords) fail(409, 'Saved removal history changed');
    await verifyStack(raw, prior, records);
    // Non-cooperating external writers cannot grant our lease. Re-read the
    // precondition immediately before publication as well as on entry.
    if ((await removalSidecarSnapshot(raw)).revision !== current.revision)
      fail(409, 'XMP changed during removal validation');
    const path = xmpSidecarPath(raw);
    const write = await writeSidecarAtomic(path, request.xml, 'Removal XMP write failed');
    if (!write.ok) fail(500, write.error);
    await syncRemovalDirectory(dirname(path));
    const result = await removalSidecarSnapshot(raw);
    if (result.revision !== revision(Buffer.from(request.xml)))
      fail(409, 'Published removal XMP could not be confirmed');
    return result;
  });
}
