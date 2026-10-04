import type { BackupObject, PublishSource, UploadCheckpoint } from '../provider.ts';
import { GoogleDriveError, logicalKeyHash } from './client.ts';
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
async function verify(
  provider: GoogleDriveProvider,
  state: GoogleCheckpoint,
  signal?: AbortSignal,
  heartbeat?: () => Promise<void>,
): Promise<BackupObject> {
  return verifiedGoogleObject(
    provider,
    { key: state.key, locator: state.fileId, size: state.size, sha256: state.sha256 },
    signal,
    heartbeat,
  );
}
function displayName(key: string, source: PublishSource): string {
  if (!source.name) return key.replace(/\//g, '__');
  const name = source.name.replace(/[\\/]/g, '_').slice(0, 200);
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${name.slice(0, dot)}__${source.sha256.slice(0, 12)}${name.slice(dot)}`
    : `${name}__${source.sha256.slice(0, 12)}`;
}

export async function publishGoogleObject(
  provider: GoogleDriveProvider,
  key: string,
  source: PublishSource,
  options: {
    signal?: AbortSignal;
    checkpoint?: UploadCheckpoint | null;
    saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
  },
): Promise<BackupObject> {
  const saved = options.checkpoint ? parseCheckpoint(options.checkpoint, provider.rootId) : null;
  if (saved && (saved.key !== key || saved.sha256 !== source.sha256 || saved.size !== source.size))
    throw new Error('Upload checkpoint content changed.');
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
  await options.saveCheckpoint(envelope(initial));
  const contentType = source.contentType ?? 'application/octet-stream';
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType))
    throw new Error('Invalid backup content type.');
  const startSession = async (): Promise<GoogleCheckpoint> => {
    const response = await provider.client.request(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Length': String(source.size),
          'X-Upload-Content-Type': contentType,
        },
        body: JSON.stringify({
          id: initial.fileId,
          name: displayName(key, source),
          mimeType: contentType,
          parents: [provider.rootId],
          properties: { mapleKeyHash: logicalKeyHash(key) },
          description: JSON.stringify({
            mapleBackupObject: 1,
            rootId: provider.rootId,
            key,
            sha256: source.sha256,
          }),
        }),
      },
      options.signal,
    );
    const session = response.headers.get('location');
    if (!session) throw new Error('Google returned no resumable upload URL.');
    const state = { ...initial, session };
    parseCheckpoint(envelope(state), provider.rootId);
    await options.saveCheckpoint(envelope(state));
    return state;
  };
  let state = initial;
  let next = 0;
  if (state.session) {
    try {
      const response = await provider.client.request(
        state.session,
        {
          method: 'PUT',
          headers: {
            'Content-Length': '0',
            'Content-Range': `bytes */${source.size}`,
          },
        },
        options.signal,
      );
      if (response.status !== 308)
        return verify(provider, state, options.signal, () =>
          options.saveCheckpoint(envelope(state)),
        );
      next = confirmedOffset(response, source.size);
    } catch (error) {
      if (!(error instanceof GoogleDriveError && [404, 410].includes(error.status))) throw error;
      try {
        return await verify(provider, state, options.signal, () =>
          options.saveCheckpoint(envelope(state)),
        );
      } catch (missing) {
        if (!(missing instanceof GoogleDriveError && missing.status === 404)) throw missing;
      }
      state = { ...state, session: null };
    }
  }
  if (!state.session) {
    try {
      state = await startSession();
    } catch (error) {
      if (error instanceof GoogleDriveError && error.status === 409)
        return verify(provider, state, options.signal, () =>
          options.saveCheckpoint(envelope(state)),
        );
      throw error;
    }
  }
  do {
    options.signal?.throwIfAborted();
    await options.saveCheckpoint(envelope(state));
    // Recheck containment on every chunk; moved roots stop ongoing work.
    await provider.probe(options.signal);
    const length = Math.min(CHUNK, source.size - next);
    const response = await provider.client.request(
      state.session!,
      {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(length),
          'Content-Range':
            length === 0 ? 'bytes */0' : `bytes ${next}-${next + length - 1}/${source.size}`,
        },
        body: await chunk(source, next, length),
      },
      options.signal,
    );
    await options.saveCheckpoint(envelope(state));
    if (response.status !== 308)
      return verify(provider, state, options.signal, () => options.saveCheckpoint(envelope(state)));
    const confirmed = confirmedOffset(response, source.size);
    if (confirmed <= next) throw new Error('Google made no resumable upload progress; retry.');
    next = confirmed;
  } while (next < source.size);
  return verify(provider, state, options.signal, () => options.saveCheckpoint(envelope(state)));
}
