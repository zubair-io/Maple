import type { BackupObject, BackupProvider, PublishSource, UploadCheckpoint } from '../provider.ts';
import {
  DriveClient,
  DRIVE_API,
  logicalKeyHash,
  GoogleDriveError,
  validateGoogleRoot,
  type DriveFile,
} from './client.ts';
import { publishGoogleObject, parseCheckpoint } from './upload.ts';
import type { GoogleFetch } from './oauth.ts';
import { verifiedGoogleObject } from './integrity.ts';

export interface ObjectMarker {
  mapleBackupObject: 1;
  rootId: string;
  key: string;
  sha256: string;
}
export function objectMarker(file: DriveFile): ObjectMarker | null {
  try {
    const marker = JSON.parse(file.description ?? '{}') as ObjectMarker;
    return marker.mapleBackupObject === 1 &&
      typeof marker.rootId === 'string' &&
      typeof marker.key === 'string' &&
      /^[a-f0-9]{64}$/.test(marker.sha256)
      ? marker
      : null;
  } catch {
    return null;
  }
}
export function backupObject(file: DriveFile, rootId: string): BackupObject {
  const marker = objectMarker(file);
  if (
    !marker ||
    marker.rootId !== rootId ||
    file.trashed ||
    file.mimeType === 'application/vnd.google-apps.shortcut' ||
    file.parents?.length !== 1 ||
    file.parents[0] !== rootId ||
    !Number.isSafeInteger(Number(file.size)) ||
    Number(file.size) < 0 ||
    (file.sha256Checksum && file.sha256Checksum !== marker.sha256)
  ) {
    throw new Error(
      'Google object moved outside the owned backup folder or failed integrity validation.',
    );
  }
  return {
    key: marker.key,
    locator: file.id,
    size: Number(file.size),
    sha256: marker.sha256,
  };
}
function validKey(key: string) {
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.split('/').some((s) => !s || s === '..' || s === '.') ||
    Array.from(key).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('Invalid backup logical key.');
  }
}

export class GoogleDriveProvider implements BackupProvider {
  readonly client: DriveClient;
  constructor(
    readonly rootId: string,
    token: () => Promise<string>,
    transport: GoogleFetch = fetch,
  ) {
    this.client = new DriveClient(token, transport);
  }
  async probe(signal?: AbortSignal) {
    await validateGoogleRoot(this.client, this.rootId, signal);
  }
  async *list(prefix: string, signal?: AbortSignal): AsyncIterable<BackupObject> {
    await this.probe(signal);
    for await (const file of this.client.list(
      `'${this.rootId}' in parents and trashed = false`,
      signal,
    )) {
      const marker = objectMarker(file);
      if (marker?.key.startsWith(prefix)) yield backupObject(file, this.rootId);
    }
  }
  async inspect(
    key: string,
    signal?: AbortSignal,
    locator?: string,
    heartbeat?: (object: BackupObject) => Promise<void>,
  ): Promise<BackupObject | null> {
    validKey(key);
    await this.probe(signal);
    if (locator) {
      try {
        const object = backupObject(await this.client.metadata(locator, signal), this.rootId);
        if (object.key !== key) throw new Error('Backup object identity changed.');
        return verifiedGoogleObject(
          this,
          object,
          signal,
          heartbeat ? () => heartbeat(object) : undefined,
        );
      } catch (error) {
        if (error instanceof GoogleDriveError && error.status === 404) return null;
        throw error;
      }
    }
    const hash = logicalKeyHash(key);
    const matches: BackupObject[] = [];
    // 76 UTF-8 bytes total, below Drive's 124-byte public-property limit.
    // https://developers.google.com/workspace/drive/api/guides/search-files
    const query = `'${this.rootId}' in parents and trashed = false and properties has { key='mapleKeyHash' and value='${hash}' }`;
    for await (const file of this.client.list(query, signal)) {
      const object = backupObject(file, this.rootId);
      if (object.key !== key || file.properties?.['mapleKeyHash'] !== hash)
        throw new Error('Google backup search index does not match its portable object identity.');
      matches.push(object);
      if (matches.length > 1)
        throw new Error('Conflicting immutable backup objects require operator review.');
    }
    const match = matches[0];
    return match
      ? verifiedGoogleObject(this, match, signal, heartbeat ? () => heartbeat(match) : undefined)
      : null;
  }
  async publish(
    key: string,
    source: PublishSource,
    options: {
      signal?: AbortSignal;
      checkpoint?: UploadCheckpoint | null;
      saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
    },
  ): Promise<BackupObject> {
    validKey(key);
    if (
      !Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    )
      throw new Error('Invalid immutable content identity.');
    await this.probe(options.signal);
    return publishGoogleObject(this, key, source, options);
  }
  async download(object: BackupObject, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    await this.probe(signal);
    const current = backupObject(await this.client.metadata(object.locator, signal), this.rootId);
    if (
      current.key !== object.key ||
      current.sha256 !== object.sha256 ||
      current.size !== object.size
    )
      throw new Error('Backup object identity changed.');
    const response = await this.client.request(
      `${DRIVE_API}/files/${object.locator}?alt=media`,
      {},
      signal,
    );
    if (!response.body) throw new Error('Google returned no object bytes.');
    return response.body;
  }
  async remove(object: BackupObject, signal?: AbortSignal) {
    await this.probe(signal);
    try {
      const current = backupObject(await this.client.metadata(object.locator, signal), this.rootId);
      if (
        current.key !== object.key ||
        current.sha256 !== object.sha256 ||
        current.size !== object.size
      )
        throw new Error('Refusing removal of changed backup object.');
      await this.client.request(
        `${DRIVE_API}/files/${object.locator}`,
        { method: 'DELETE' },
        signal,
      );
    } catch (error) {
      if (!(error instanceof GoogleDriveError && error.status === 404)) throw error;
    }
  }
  async abort(checkpoint: UploadCheckpoint, signal?: AbortSignal) {
    const state = parseCheckpoint(checkpoint, this.rootId);
    await this.probe(signal);
    if (state.session) {
      try {
        await this.client.request(state.session, { method: 'DELETE' }, signal);
      } catch (error) {
        if (!(error instanceof GoogleDriveError && [404, 410].includes(error.status))) throw error;
      }
    }
    // Cancellation precedes cleanup: a final chunk racing cancellation can
    // still have committed the reserved ID. Refuse any changed/moved object.
    try {
      const file = await this.client.metadata(state.fileId, signal);
      const object = backupObject(file, this.rootId);
      if (object.key !== state.key || object.sha256 !== state.sha256 || object.size !== state.size)
        throw new Error('Refusing cleanup of a changed upload reservation.');
      await this.remove(object, signal);
    } catch (error) {
      if (!(error instanceof GoogleDriveError && error.status === 404)) throw error;
    }
    try {
      await this.client.metadata(state.fileId, signal);
      throw new Error('Google upload cleanup has not completed; retry purge.');
    } catch (error) {
      if (!(error instanceof GoogleDriveError && error.status === 404)) throw error;
    }
  }
}
