import type { BackupObject, PublishSource, UploadCheckpoint } from '../provider.ts';
import { isDriveStatus, logicalKeyHash } from './client.ts';
import type { GoogleDriveProvider } from './provider.ts';
import { verifiedGoogleObject } from './integrity.ts';
import { assertObjectIdentity, ObjectIdentityError } from './object.ts';

const CHUNK = 8 * 1024 * 1024;
interface GoogleCheckpoint {
  rootId: string;
  key: string;
  fileId: string;
  parentId: string;
  name: string;
  replace: boolean;
  exactName: boolean;
  sha256: string;
  size: number;
  session: string | null;
  legacy?: boolean;
}
function normalizeCheckpoint(saved: GoogleCheckpoint, rootId: string): GoogleCheckpoint {
  const hasPlacement = [saved.parentId, saved.name, saved.replace, saved.exactName].some(
    (value) => value !== undefined,
  );
  return hasPlacement
    ? { ...saved, legacy: false }
    : {
        ...saved,
        parentId: rootId,
        name: typeof saved.key === 'string' ? saved.key.replace(/\//g, '__') : '',
        replace: false,
        exactName: false,
        legacy: true,
      };
}
function validCheckpointCore(state: GoogleCheckpoint, rootId: string): boolean {
  return (
    state.rootId === rootId &&
    /^[A-Za-z0-9_-]{1,200}$/.test(state.fileId) &&
    typeof state.key === 'string' &&
    Boolean(state.key) &&
    /^[a-f0-9]{64}$/.test(state.sha256) &&
    Number.isSafeInteger(state.size) &&
    state.size >= 0
  );
}
function validCheckpointPlacement(state: GoogleCheckpoint): boolean {
  if (state.legacy) return true;
  return (
    typeof state.parentId === 'string' &&
    /^[A-Za-z0-9_-]{1,200}$/.test(state.parentId) &&
    Boolean(state.name) &&
    typeof state.replace === 'boolean' &&
    typeof state.exactName === 'boolean'
  );
}
function validCheckpoint(state: GoogleCheckpoint, rootId: string): boolean {
  return validCheckpointCore(state, rootId) && validCheckpointPlacement(state);
}
function validateSession(state: GoogleCheckpoint): void {
  if (!state.session) return;
  const session = new URL(state.session);
  if (
    session.origin !== 'https://www.googleapis.com' ||
    !/^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]{1,200})?$/.test(session.pathname) ||
    (state.replace && session.pathname !== `/upload/drive/v3/files/${state.fileId}`) ||
    (!state.replace && session.pathname !== '/upload/drive/v3/files') ||
    !session.searchParams.has('upload_id')
  )
    throw new Error('Invalid Google resumable session.');
}
export function parseCheckpoint(checkpoint: UploadCheckpoint, rootId: string): GoogleCheckpoint {
  const state = normalizeCheckpoint(checkpoint.state as unknown as GoogleCheckpoint, rootId);
  if (
    checkpoint.provider !== 'google-drive' ||
    checkpoint.version !== 1 ||
    !validCheckpoint(state, rootId)
  )
    throw new Error('Invalid Google upload checkpoint.');
  validateSession(state);
  return state;
}
const envelope = (state: GoogleCheckpoint): UploadCheckpoint => ({
  provider: 'google-drive',
  version: 1,
  state: {
    rootId: state.rootId,
    key: state.key,
    fileId: state.fileId,
    parentId: state.parentId,
    name: state.name,
    replace: state.replace,
    exactName: state.exactName,
    sha256: state.sha256,
    size: state.size,
    session: state.session,
  },
});

async function chunk(
  source: PublishSource,
  offset: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = source.open(offset).getReader();
  const bytes = new Uint8Array(length);
  let received = 0;
  try {
    while (received < length) {
      const result = await reader.read();
      if (result.done)
        throw new Error('Backup source changed or became unavailable during upload.');
      const count = Math.min(result.value.length, length - received);
      bytes.set(result.value.subarray(0, count), received);
      received += count;
    }
    return bytes;
  } finally {
    await reader.cancel();
  }
}
function confirmedOffset(response: Response, size: number): number {
  const range = response.headers.get('range');
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const next = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(next) || next > size || next < 0)
    throw new Error('Invalid Google upload progress.');
  return next;
}
interface UploadOptions {
  signal?: AbortSignal;
  checkpoint?: UploadCheckpoint | null;
  expected?: BackupObject | null;
  saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
}
interface UploadContext {
  provider: GoogleDriveProvider;
  key: string;
  source: PublishSource;
  options: UploadOptions;
  replace: boolean;
}
const save = (ctx: UploadContext, state: GoogleCheckpoint) =>
  ctx.options.saveCheckpoint(envelope(state));
async function verify(ctx: UploadContext, state: GoogleCheckpoint): Promise<BackupObject> {
  const object = await verifiedGoogleObject(
    ctx.provider,
    {
      key: state.key,
      locator: state.fileId,
      size: state.size,
      sha256: state.sha256,
    },
    ctx.options.signal,
    () => save(ctx, state),
  );
  assertObjectIdentity(
    object,
    {
      key: state.key,
      locator: state.fileId,
      size: state.size,
      sha256: state.sha256,
    },
    'Google upload read-back checksum mismatch.',
  );
  return object;
}
function contentType(source: PublishSource): string {
  const type = source.contentType ?? 'application/octet-stream';
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)) throw new Error('Invalid backup content type.');
  return type;
}
function displayName(key: string, source: PublishSource): string {
  if (!source.name) return key.replace(/\//g, '__');
  const name = source.name.replace(/[\\/]/g, '_').slice(0, 200);
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${name.slice(0, dot)}__${source.sha256.slice(0, 12)}${name.slice(dot)}`
    : `${name}__${source.sha256.slice(0, 12)}`;
}

async function savedCheckpoint(ctx: UploadContext): Promise<GoogleCheckpoint | null> {
  if (!ctx.options.checkpoint) return null;
  const state = parseCheckpoint(ctx.options.checkpoint, ctx.provider.rootId);
  if (state.legacy) {
    await ctx.provider.abort(ctx.options.checkpoint, ctx.options.signal);
    return null;
  }
  if (state.key !== ctx.key || state.sha256 !== ctx.source.sha256 || state.size !== ctx.source.size)
    throw new Error('Upload checkpoint content changed.');
  return state;
}
function checkpointObject(state: GoogleCheckpoint): BackupObject {
  return { key: state.key, locator: state.fileId, size: state.size, sha256: state.sha256 };
}
// An in-flight checkpoint names the file this upload is writing. A database
// mapping left behind by an object that has since vanished from Drive must not
// veto resuming it, or every retry rejects the completed replacement.
function mappedObject(state: GoogleCheckpoint | null, expected?: BackupObject | null) {
  return state ? checkpointObject(state) : (expected ?? undefined);
}
// A mirror checkpoint that reserved a different file than the database maps
// may already have committed (final response lost). That file is the live
// replacement at this path; reserving again would orphan it beside the mapped
// one, and the exact-path discovery would then refuse the duplicate forever.
function committedCheckpoint(ctx: UploadContext, state: GoogleCheckpoint) {
  return ctx.provider.inspect(ctx.key, ctx.options.signal, {
    locator: state.fileId,
    expected: checkpointObject(state),
  });
}
async function startSession(
  ctx: UploadContext,
  state: GoogleCheckpoint,
): Promise<GoogleCheckpoint> {
  const type = contentType(ctx.source);
  const target = await ctx.provider.objectTarget(ctx.key, ctx.options.signal);
  if (target.parentId !== state.parentId || target.name !== state.name)
    throw new Error('Google upload checkpoint destination changed.');
  const response = await ctx.provider.client.request(
    `https://www.googleapis.com/upload/drive/v3/files${state.replace ? `/${state.fileId}` : ''}?uploadType=resumable`,
    {
      method: state.replace ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(ctx.source.size),
        'X-Upload-Content-Type': type,
      },
      body: JSON.stringify({
        ...(!state.replace ? { id: state.fileId, parents: [state.parentId] } : {}),
        name: state.exactName ? state.name : displayName(ctx.key, ctx.source),
        mimeType: type,
        // This metadata is a portable discovery hint for catalog listings.
        // Database mappings, not this mutable marker, identify known mirror files.
        properties: { mapleKeyHash: logicalKeyHash(ctx.key) },
        description: JSON.stringify({
          mapleBackupObject: 1,
          rootId: ctx.provider.rootId,
          key: ctx.key,
          sha256: ctx.source.sha256,
        }),
      }),
    },
    ctx.options.signal,
  );
  const session = response.headers.get('location');
  if (!session) throw new Error('Google returned no resumable upload URL.');
  const pending = { ...state, session };
  parseCheckpoint(envelope(pending), ctx.provider.rootId);
  await save(ctx, pending);
  return pending;
}
interface Progress {
  state: GoogleCheckpoint;
  next: number;
  completed: BackupObject | null;
}
async function reconcileExpiredReplacement(
  ctx: UploadContext,
  state: GoogleCheckpoint,
  error: unknown,
): Promise<Progress> {
  const current = await ctx.provider.inspect(state.key, ctx.options.signal, {
    locator: state.fileId,
    expected: {
      key: state.key,
      locator: state.fileId,
      size: state.size,
      sha256: state.sha256,
    },
  });
  if (current) {
    if (current.sha256 === state.sha256 && current.size === state.size)
      return { state, next: 0, completed: current };
    return { state: { ...state, session: null }, next: 0, completed: null };
  }
  if (!isDriveStatus(error, 404)) throw error;
  return {
    state: {
      ...state,
      fileId: await ctx.provider.client.reserveId(ctx.options.signal),
      replace: false,
      session: null,
    },
    next: 0,
    completed: null,
  };
}
async function reconcileExpired(ctx: UploadContext, state: GoogleCheckpoint): Promise<Progress> {
  try {
    return { state, next: 0, completed: await verify(ctx, state) };
  } catch (error) {
    if (state.replace) return reconcileExpiredReplacement(ctx, state, error);
    if (!isDriveStatus(error, 404)) throw error;
    return { state: { ...state, session: null }, next: 0, completed: null };
  }
}
async function probeSession(ctx: UploadContext, state: GoogleCheckpoint): Promise<Progress> {
  if (!state.session) return { state, next: 0, completed: null };
  try {
    const response = await ctx.provider.client.request(
      state.session,
      {
        method: 'PUT',
        headers: {
          'Content-Length': '0',
          'Content-Range': `bytes */${ctx.source.size}`,
        },
      },
      ctx.options.signal,
    );
    if (response.status !== 308) return { state, next: 0, completed: await verify(ctx, state) };
    return {
      state,
      next: confirmedOffset(response, ctx.source.size),
      completed: null,
    };
  } catch (error) {
    if (!isDriveStatus(error, 404, 410)) throw error;
    return reconcileExpired(ctx, state);
  }
}
async function createSession(ctx: UploadContext, state: GoogleCheckpoint): Promise<Progress> {
  try {
    return { state: await startSession(ctx, state), next: 0, completed: null };
  } catch (error) {
    if (!isDriveStatus(error, 409)) throw error;
    return { state, next: 0, completed: await verify(ctx, state) };
  }
}
async function sendChunk(
  ctx: UploadContext,
  state: GoogleCheckpoint,
  next: number,
): Promise<Response> {
  ctx.options.signal?.throwIfAborted();
  await save(ctx, state);
  // Each chunk probes containment; checkpoint writes fence the current lease.
  await ctx.provider.probe(ctx.options.signal);
  const length = Math.min(CHUNK, ctx.source.size - next);
  const response = await ctx.provider.client.request(
    state.session!,
    {
      method: 'PUT',
      headers: {
        'Content-Type': contentType(ctx.source),
        'Content-Length': String(length),
        // Empty files use the single-request PUT form. bytes */0 is reserved
        // for a session-status probe, not a completed empty media upload.
        // Google's official google-api-python-client omits this header too.
        ...(length > 0
          ? {
              'Content-Range': `bytes ${next}-${next + length - 1}/${ctx.source.size}`,
            }
          : {}),
      },
      body: await chunk(ctx.source, next, length),
    },
    ctx.options.signal,
  );
  await save(ctx, state);
  return response;
}
async function uploadChunks(
  ctx: UploadContext,
  state: GoogleCheckpoint,
  offset: number,
): Promise<BackupObject> {
  let next = offset;
  do {
    const response = await sendChunk(ctx, state, next);
    if (response.status !== 308) return verify(ctx, state);
    const confirmed = confirmedOffset(response, ctx.source.size);
    if (confirmed <= next) throw new Error('Google made no resumable upload progress; retry.');
    next = confirmed;
  } while (next < ctx.source.size);
  return verify(ctx, state);
}
function matchesSource(object: BackupObject | null, source: PublishSource): object is BackupObject {
  return Boolean(object && object.sha256 === source.sha256 && object.size === source.size);
}
async function mirrorCheckpoint(
  ctx: UploadContext,
  target: { parentId: string; name: string },
): Promise<GoogleCheckpoint | null> {
  const checkpoint = ctx.options.checkpoint;
  if (!checkpoint) return null;
  const saved = parseCheckpoint(checkpoint, ctx.provider.rootId);
  if (saved.legacy) {
    await ctx.provider.abort(checkpoint, ctx.options.signal);
    return null;
  }
  if (saved.key !== ctx.key || saved.parentId !== target.parentId || saved.name !== target.name)
    throw new Error('Google mirror checkpoint destination changed.');
  return saved;
}
async function mirrorState(
  ctx: UploadContext,
  target: { parentId: string; name: string },
  saved: GoogleCheckpoint | null,
  existing: BackupObject | null,
): Promise<GoogleCheckpoint> {
  if (saved && (saved.sha256 !== ctx.source.sha256 || saved.size !== ctx.source.size)) {
    await ctx.provider.abort(envelope(saved), ctx.options.signal);
    saved = null;
  }
  const state = saved ?? {
    rootId: ctx.provider.rootId,
    key: ctx.key,
    fileId: existing?.locator ?? (await ctx.provider.client.reserveId(ctx.options.signal)),
    parentId: target.parentId,
    name: target.name,
    replace: Boolean(existing),
    exactName: true,
    sha256: ctx.source.sha256,
    size: ctx.source.size,
    session: null,
  };
  await save(ctx, state);
  return state;
}
async function uploadMirror(ctx: UploadContext, state: GoogleCheckpoint): Promise<BackupObject> {
  contentType(ctx.source);
  const probed = await probeSession(ctx, state);
  if (matchesSource(probed.completed, ctx.source)) return probed.completed;
  const ready = probed.state.session ? probed : await createSession(ctx, probed.state);
  if (matchesSource(ready.completed, ctx.source)) return ready.completed;
  return uploadChunks(ctx, ready.state, ready.next);
}
export async function publishGoogleObject(
  provider: GoogleDriveProvider,
  key: string,
  source: PublishSource,
  options: UploadOptions,
): Promise<BackupObject> {
  const target = await provider.objectTarget(key, options.signal);
  const ctx = { provider, key, source, options, replace: false };
  const saved = await savedCheckpoint(ctx);
  const expected = mappedObject(saved, options.expected);
  const existing = await provider.inspect(key, options.signal, {
    locator: saved?.fileId ?? expected?.locator,
    expected,
  });
  if (existing) {
    if (existing.sha256 !== source.sha256 || existing.size !== source.size)
      throw new Error('Immutable backup key conflicts with different content.');
    return existing;
  }
  const initial = saved ?? {
    rootId: provider.rootId,
    key,
    fileId: await provider.client.reserveId(options.signal),
    parentId: target.parentId,
    name: target.name,
    replace: false,
    exactName: !source.name,
    sha256: source.sha256,
    size: source.size,
    session: null,
  };
  await save(ctx, initial);
  contentType(source);
  const probed = await probeSession(ctx, initial);
  if (probed.completed) return probed.completed;
  const ready = probed.state.session ? probed : await createSession(ctx, probed.state);
  if (ready.completed) return ready.completed;
  return uploadChunks(ctx, ready.state, ready.next);
}

async function atMirrorTarget(
  ctx: UploadContext,
  object: BackupObject,
  target: { parentId: string; name: string },
): Promise<boolean> {
  const file = await ctx.provider.client.metadata(object.locator, ctx.options.signal);
  return file.name === target.name && file.parents?.[0] === target.parentId;
}
// A displaced copy whose bytes changed after inspection is no longer Maple's
// to delete; everything else (network, auth) surfaces so the retry converges.
async function removeDisplacedCopy(ctx: UploadContext, copy: BackupObject): Promise<void> {
  try {
    await ctx.provider.remove(copy, ctx.options.signal);
  } catch (error) {
    if (!(error instanceof ObjectIdentityError)) throw error;
  }
}
async function mirrorCandidates(
  ctx: UploadContext,
  target: { parentId: string; name: string },
  candidates: BackupObject[],
): Promise<{ existing: BackupObject | null; displaced: BackupObject[] }> {
  const placed: BackupObject[] = [];
  for (const candidate of candidates)
    if (await atMirrorTarget(ctx, candidate, target)) placed.push(candidate);
  const existing = placed[0] ?? null;
  return { existing, displaced: candidates.filter((candidate) => candidate !== existing) };
}
export async function publishGoogleMirrorFile(
  provider: GoogleDriveProvider,
  key: string,
  relativePath: string,
  source: PublishSource,
  options: UploadOptions,
): Promise<BackupObject> {
  const target = await provider.objectTarget(key, options.signal);
  if (target.name !== relativePath.split('/').at(-1))
    throw new Error('Invalid Google mirror path.');
  const ctx = { provider, key, source, options, replace: true };
  const checkpoint = await mirrorCheckpoint(ctx, target);
  // A checkpoint may outlive the DB mapping it was created from (for
  // example, after another worker completed a replacement). Unless its file
  // already committed, the DB locator wins: discard the stale resumable
  // session and rebuild the mirror state against the mapped object instead of
  // passing contradictory identities to inspect(). The abandoned Google
  // session expires without mutating files.
  const divergent = Boolean(
    checkpoint && options.expected && checkpoint.fileId !== options.expected.locator,
  );
  const committed = divergent ? await committedCheckpoint(ctx, checkpoint!) : null;
  const saved = divergent ? null : checkpoint;
  const expected = mappedObject(saved, options.expected);
  const mapped = await provider.inspect(key, options.signal, {
    locator: saved?.fileId ?? expected?.locator,
    expected,
  });
  // The mirror's contract is the library-relative path. A mapped or committed
  // file that was renamed or moved inside the root, or a second copy left by
  // an interrupted replacement, is removed once the file at the path is
  // confirmed; the engine's key-based cleanup never sees those locators.
  const { existing, displaced } = await mirrorCandidates(
    ctx,
    target,
    [committed, mapped].filter((candidate): candidate is BackupObject => candidate !== null),
  );
  const resumable = saved && displaced.some((copy) => copy.locator === saved.fileId) ? null : saved;
  const published = matchesSource(existing, source)
    ? existing
    : await uploadMirror(ctx, await mirrorState(ctx, target, resumable, existing));
  for (const copy of displaced) await removeDisplacedCopy(ctx, copy);
  return published;
}
