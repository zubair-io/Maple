import { createHash } from 'node:crypto';
import type { GoogleFetch } from './oauth.ts';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const FILE_FIELDS =
  'id,name,mimeType,parents,trashed,size,sha256Checksum,description,properties,ownedByMe,driveId';
/** Public search index; full logical keys remain in portable description metadata. */
export const logicalKeyHash = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');
export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
  size?: string;
  sha256Checksum?: string;
  description?: string;
  properties?: Record<string, string>;
  ownedByMe?: boolean;
  driveId?: string;
}
export class GoogleDriveError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
  ) {
    super(
      status === 404
        ? 'Google backup object is unavailable.'
        : status === 403
          ? 'Google Drive denied access. Check Drive API, quota and Workspace policy.'
          : `Google Drive request failed (${status}).`,
    );
  }
}
export class DriveClient {
  constructor(
    private token: () => Promise<string>,
    readonly transport: GoogleFetch = fetch,
  ) {}
  async request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const parsed = new URL(url);
    if (
      parsed.origin !== 'https://www.googleapis.com' ||
      (!parsed.pathname.startsWith('/drive/v3/') &&
        !parsed.pathname.startsWith('/upload/drive/v3/'))
    ) {
      throw new Error('Invalid Google Drive endpoint.');
    }
    const token = await this.token();
    const response = await this.transport(parsed, {
      ...init,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${token}`,
      },
    }).catch(() => {
      throw new GoogleDriveError(0, null);
    });
    if (!response.ok && response.status !== 308) {
      const raw = response.headers.get('retry-after');
      const seconds = raw === null ? NaN : Number(raw);
      const retry =
        raw === null
          ? null
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Math.max(0, Date.parse(raw) - Date.now());
      throw new GoogleDriveError(
        response.status,
        retry !== null && Number.isFinite(retry) ? retry : null,
      );
    }
    return response;
  }
  async json<T>(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    return (await this.request(url, init, signal)).json() as Promise<T>;
  }
  metadata(id: string, signal?: AbortSignal): Promise<DriveFile> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid Google file identifier.');
    return this.json(`${DRIVE_API}/files/${id}?fields=${FILE_FIELDS}`, {}, signal);
  }
  async reserveId(signal?: AbortSignal): Promise<string> {
    const response = await this.json<{ ids: string[] }>(
      `${DRIVE_API}/files/generateIds?count=1&space=drive&type=files`,
      {},
      signal,
    );
    if (!response.ids?.[0]) throw new Error('Google could not reserve an immutable file ID.');
    return response.ids[0];
  }
  async *list(query: string, signal?: AbortSignal): AsyncIterable<DriveFile> {
    let page: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: '1000',
        spaces: 'drive',
      });
      if (page) params.set('pageToken', page);
      const response = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(
        `${DRIVE_API}/files?${params}`,
        {},
        signal,
      );
      yield* response.files ?? [];
      page = response.nextPageToken;
    } while (page);
  }
}

export async function createGoogleRoot(
  token: () => Promise<string>,
  transport: GoogleFetch = fetch,
  reservedId?: string,
): Promise<string> {
  const client = new DriveClient(token, transport);
  const id = reservedId ?? (await client.reserveId());
  if (reservedId) {
    try {
      await validateGoogleRoot(client, id);
      return id;
    } catch (error) {
      if (!(error instanceof GoogleDriveError && error.status === 404)) throw error;
    }
  }
  try {
    const root = await client.json<DriveFile>(`${DRIVE_API}/files?fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name: 'Maple Photo Backup',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        description: JSON.stringify({
          mapleBackupRoot: 1,
          identity: crypto.randomUUID(),
        }),
      }),
    });
    return root.id;
  } catch (error) {
    if (error instanceof GoogleDriveError && error.status === 409) {
      await validateGoogleRoot(client, id);
      return id;
    }
    throw error;
  }
}

export async function validateGoogleRoot(
  client: DriveClient,
  id: string,
  signal?: AbortSignal,
): Promise<DriveFile> {
  const root = await client.metadata(id, signal);
  const marker = (() => {
    try {
      return JSON.parse(root.description ?? '{}') as {
        mapleBackupRoot?: number;
        identity?: string;
      };
    } catch {
      return null;
    }
  })();
  // Google returns an opaque My Drive parent ID, not the 'root' alias.
  if (
    root.trashed ||
    root.ownedByMe === false ||
    root.driveId ||
    root.mimeType !== 'application/vnd.google-apps.folder' ||
    root.parents?.length !== 1 ||
    marker?.mapleBackupRoot !== 1 ||
    !marker.identity
  ) {
    throw new Error('Select an existing Maple-owned backup folder in My Drive.');
  }
  return root;
}
