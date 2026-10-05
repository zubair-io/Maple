import type { BackupObject, BackupProvider, PublishSource, UploadCheckpoint } from '../provider.ts';
import {
  DriveClient,
  DRIVE_API,
  logicalKeyHash,
  isDriveStatus,
  validateGoogleRoot,
} from './client.ts';
import { publishGoogleObject, parseCheckpoint } from './upload.ts';
import type { GoogleFetch } from './oauth.ts';
import { verifiedGoogleObject } from './integrity.ts';

import { objectMarker, backupObject, assertObjectIdentity } from './object.ts';

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
    const match = locator
      ? await this.inspectLocator(key, locator, signal)
      : await this.inspectIndex(key, signal);
    if (!match) return null;
    return verifiedGoogleObject(
      this,
      match,
      signal,
      heartbeat ? () => heartbeat(match) : undefined,
    );
  }
  private async inspectLocator(
    key: string,
    locator: string,
    signal?: AbortSignal,
  ): Promise<BackupObject | null> {
    try {
      const object = backupObject(await this.client.metadata(locator, signal), this.rootId);
      if (object.key !== key) throw new Error('Backup object identity changed.');
      return object;
    } catch (error) {
      if (isDriveStatus(error, 404)) return null;
      throw error;
    }
  }
  private async inspectIndex(key: string, signal?: AbortSignal): Promise<BackupObject | null> {
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
    return matches[0] ?? null;
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
    assertObjectIdentity(current, object, 'Backup object identity changed.');
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
      assertObjectIdentity(current, object, 'Refusing removal of changed backup object.');
      await this.client.request(
        `${DRIVE_API}/files/${object.locator}`,
        { method: 'DELETE' },
        signal,
      );
    } catch (error) {
      if (!isDriveStatus(error, 404)) throw error;
    }
  }
  async abort(checkpoint: UploadCheckpoint, signal?: AbortSignal) {
    const state = parseCheckpoint(checkpoint, this.rootId);
    await this.probe(signal);
    await this.cancelSession(state.session, signal);
    // Cancellation precedes cleanup: a final chunk racing cancellation can
    // still have committed the reserved ID. Refuse any changed/moved object.
    await this.removeReservation(
      { key: state.key, locator: state.fileId, sha256: state.sha256, size: state.size },
      signal,
    );
    await this.confirmMissing(state.fileId, signal);
  }
  private async cancelSession(session: string | null, signal?: AbortSignal): Promise<void> {
    if (!session) return;
    try {
      await this.client.request(session, { method: 'DELETE' }, signal);
    } catch (error) {
      if (!isDriveStatus(error, 404, 410)) throw error;
    }
  }
  private async removeReservation(expected: BackupObject, signal?: AbortSignal): Promise<void> {
    try {
      const object = backupObject(
        await this.client.metadata(expected.locator, signal),
        this.rootId,
      );
      assertObjectIdentity(object, expected, 'Refusing cleanup of a changed upload reservation.');
      await this.remove(object, signal);
    } catch (error) {
      if (!isDriveStatus(error, 404)) throw error;
    }
  }
  private async confirmMissing(fileId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.metadata(fileId, signal);
      throw new Error('Google upload cleanup has not completed; retry purge.');
    } catch (error) {
      if (!isDriveStatus(error, 404)) throw error;
    }
  }
}
