import { createHash } from 'node:crypto';
import type { GoogleFetch } from './oauth.ts';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FILE_FIELDS =
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
/** Shared-drive ownership is collective; only an affirmative My Drive owner is allowed. */
export function isOwnedMyDriveFile(file: DriveFile): boolean {
  return file.ownedByMe === true && file.driveId === undefined;
}
class GoogleDriveError extends Error {
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
export function isDriveStatus(error: unknown, ...statuses: number[]): error is GoogleDriveError {
  return error instanceof GoogleDriveError && statuses.includes(error.status);
}
function driveEndpoint(url: string): URL {
  const parsed = new URL(url);
  if (
    parsed.origin !== 'https://www.googleapis.com' ||
    (!parsed.pathname.startsWith('/drive/v3/') && !parsed.pathname.startsWith('/upload/drive/v3/'))
  )
    throw new Error('Invalid Google Drive endpoint.');
  return parsed;
}
function retryAfter(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  const retry = Number.isFinite(seconds)
    ? seconds * 1000
    : Math.max(0, Date.parse(raw) - Date.now());
  return Number.isFinite(retry) ? retry : null;
}
/** Drive uses 308 as upload progress, rather than an HTTP redirect.
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads */
function resumableProgress(url: URL, init: RequestInit, response: Response): boolean {
  return (
    response.status === 308 &&
    init.method === 'PUT' &&
    /^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]{1,200})?$/.test(url.pathname) &&
    !!url.searchParams.get('upload_id') &&
    !response.headers.has('location')
  );
}
export class DriveClient {
  constructor(
    private token: () => Promise<string>,
    readonly transport: GoogleFetch = fetch,
  ) {}
  async request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const parsed = driveEndpoint(url);
    const token = await this.token();
    const response = await this.transport(parsed, {
      ...init,
      // Native Bun rejects 308 even without Location under redirect:'error'.
      // Manual mode never forwards credentials and lets us validate progress.
      redirect: 'manual',
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
    if (!response.ok && !resumableProgress(parsed, init, response)) {
      await response.body?.cancel().catch(() => {});
      throw new GoogleDriveError(response.status, retryAfter(response));
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
    !isOwnedMyDriveFile(root) ||
    root.mimeType !== 'application/vnd.google-apps.folder' ||
    root.parents?.length !== 1 ||
    marker?.mapleBackupRoot !== 1 ||
    !marker.identity
  ) {
    throw new Error('Select an existing Maple-owned backup folder in My Drive.');
  }
  return root;
}
