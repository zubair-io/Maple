import type { BackupObject, PublishSource, UploadCheckpoint } from '../provider.ts';
import { isDriveStatus, logicalKeyHash } from './client.ts';
import type { GoogleDriveProvider } from './provider.ts';
import { verifiedGoogleObject } from './integrity.ts';

const CHUNK = 8 * 1024 * 1024;
interface GoogleCheckpoint {
  rootId: string;
  key: string;
  fileId: string;
  sha256: string;
  size: number;
  session: string | null;
}
export function parseCheckpoint(checkpoint: UploadCheckpoint, rootId: string): GoogleCheckpoint {
  const state = checkpoint.state as unknown as GoogleCheckpoint;
  if (
    checkpoint.provider !== 'google-drive' ||
    checkpoint.version !== 1 ||
    state.rootId !== rootId ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(state.fileId) ||
    !state.key ||
    !/^[a-f0-9]{64}$/.test(state.sha256) ||
    !Number.isSafeInteger(state.size) ||
    state.size < 0
  )
    throw new Error('Invalid Google upload checkpoint.');
  if (state.session) {
    const session = new URL(state.session);
    if (
      session.origin !== 'https://www.googleapis.com' ||
      session.pathname !== '/upload/drive/v3/files' ||
      !session.searchParams.has('upload_id')
    )
      throw new Error('Invalid Google resumable session.');
  }
  return state;
}
const envelope = (state: GoogleCheckpoint): UploadCheckpoint => ({
  provider: 'google-drive',
  version: 1,
  state: { ...state },
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
  saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
}
interface UploadContext {
  provider: GoogleDriveProvider;
  key: string;
  source: PublishSource;
  options: UploadOptions;
}
const save = (ctx: UploadContext, state: GoogleCheckpoint) =>
  ctx.options.saveCheckpoint(envelope(state));
async function verify(ctx: UploadContext, state: GoogleCheckpoint): Promise<BackupObject> {
  return verifiedGoogleObject(
    ctx.provider,
    { key: state.key, locator: state.fileId, size: state.size, sha256: state.sha256 },
    ctx.options.signal,
    () => save(ctx, state),
  );
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

function savedCheckpoint(ctx: UploadContext): GoogleCheckpoint | null {
  if (!ctx.options.checkpoint) return null;
  const state = parseCheckpoint(ctx.options.checkpoint, ctx.provider.rootId);
  if (state.key !== ctx.key || state.sha256 !== ctx.source.sha256 || state.size !== ctx.source.size)
    throw new Error('Upload checkpoint content changed.');
  return state;
}
async function startSession(
  ctx: UploadContext,
  state: GoogleCheckpoint,
): Promise<GoogleCheckpoint> {
  const type = contentType(ctx.source);
  const response = await ctx.provider.client.request(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(ctx.source.size),
        'X-Upload-Content-Type': type,
      },
      body: JSON.stringify({
        id: state.fileId,
        name: displayName(ctx.key, ctx.source),
        mimeType: type,
        parents: [ctx.provider.rootId],
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
async function reconcileExpired(ctx: UploadContext, state: GoogleCheckpoint): Promise<Progress> {
  try {
    return { state, next: 0, completed: await verify(ctx, state) };
  } catch (error) {
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
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${ctx.source.size}` },
      },
      ctx.options.signal,
    );
    if (response.status !== 308) return { state, next: 0, completed: await verify(ctx, state) };
    return { state, next: confirmedOffset(response, ctx.source.size), completed: null };
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
          ? { 'Content-Range': `bytes ${next}-${next + length - 1}/${ctx.source.size}` }
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
export async function publishGoogleObject(
  provider: GoogleDriveProvider,
  key: string,
  source: PublishSource,
  options: UploadOptions,
): Promise<BackupObject> {
  const ctx = { provider, key, source, options };
  const saved = savedCheckpoint(ctx);
  const existing = await provider.inspect(key, options.signal, saved?.fileId);
  if (existing) {
    if (existing.sha256 !== source.sha256 || existing.size !== source.size)
      throw new Error('Immutable backup key conflicts with different content.');
    return existing;
  }
  const initial = saved ?? {
    rootId: provider.rootId,
    key,
    fileId: await provider.client.reserveId(options.signal),
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
