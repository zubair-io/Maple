import type { BackupObject, BackupProvider, PublishSource, UploadCheckpoint } from '../provider.ts';
import {
  DriveClient,
  DRIVE_API,
  logicalKeyHash,
  isDriveStatus,
  isOwnedMyDriveFile,
  validateGoogleRoot,
  type DriveFile,
} from './client.ts';
import { publishGoogleObject, publishGoogleMirrorFile, parseCheckpoint } from './upload.ts';
import type { GoogleFetch } from './oauth.ts';
import { verifiedGoogleObject } from './integrity.ts';

import { objectMarker, backupObject, assertObjectIdentity } from './object.ts';

function managedFolder(file: DriveFile, rootId: string): boolean {
  try {
    const marker = JSON.parse(file.description ?? '') as Record<string, unknown>;
    return marker.mapleBackupFolder === 1 && marker.rootId === rootId;
  } catch {
    return false;
  }
}

function validKey(key: string) {
  if (
    !key ||
    key.length > 5000 ||
    key.startsWith('/') ||
    key.split('/').some((s) => !s || s === '..' || s === '.') ||
    Array.from(key).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('Invalid backup logical key.');
  }
}
function listingFolderParts(prefix: string): string[] {
  if (!prefix) return [];
  const mappedPath = prefix.startsWith('mirror/')
    ? prefix.split('/').slice(2).join('/')
    : `.maple-backup/${prefix}`;
  const pathParts = mappedPath.split('/').filter(Boolean);
  return prefix.endsWith('/') ? pathParts : pathParts.slice(0, -1);
}

export class GoogleDriveProvider implements BackupProvider {
  readonly client: DriveClient;
  private readonly folders = new Map<string, string>();
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
  async objectTarget(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ parentId: string; name: string }> {
    validKey(key);
    const relativePath = this.objectPath(key);
    const parts = relativePath.split('/');
    const name = parts.pop()!;
    return { parentId: await this.ensureFolders(parts, signal), name };
  }
  private objectPath(key: string): string {
    const mirrorParts = key.split('/');
    const relativePath =
      mirrorParts[0] === 'mirror' ? mirrorParts.slice(2).join('/') : `.maple-backup/${key}`;
    if (!relativePath) throw new Error('Invalid Google mirror path.');
    return relativePath;
  }
  private async findFolders(parts: string[], signal?: AbortSignal): Promise<string | null> {
    let parentId = this.rootId;
    let path = '';
    for (const name of parts) {
      path = path ? `${path}/${name}` : name;
      const cached = this.folders.get(path);
      if (cached) {
        await this.assertManagedFolder(cached, signal);
        parentId = cached;
        continue;
      }
      if (parentId !== this.rootId) await this.assertManagedFolder(parentId, signal);
      const marker = JSON.stringify({ mapleBackupFolder: 1, rootId: this.rootId, path });
      const existing = [];
      for await (const child of this.client.list(
        `'${parentId}' in parents and trashed = false`,
        signal,
      ))
        if (child.name === name && child.mimeType === 'application/vnd.google-apps.folder')
          existing.push(child);
      if (existing.length > 1)
        throw new Error(`Multiple folders named ${name} exist in the Maple backup path.`);
      if (!existing.length) return null;
      const folder = existing[0]!;
      if (
        folder.description !== marker ||
        folder.parents?.[0] !== parentId ||
        !isOwnedMyDriveFile(folder)
      )
        throw new Error(`The folder ${name} in the Maple backup path is not Maple-managed.`);
      this.folders.set(path, folder.id);
      parentId = folder.id;
    }
    return parentId;
  }
  private async ensureFolders(parts: string[], signal?: AbortSignal): Promise<string> {
    let parentId = this.rootId;
    let path = '';
    for (const name of parts) {
      path = path ? `${path}/${name}` : name;
      const cached = this.folders.get(path);
      if (cached) {
        await this.assertManagedFolder(cached, signal);
        parentId = cached;
        continue;
      }
      if (parentId !== this.rootId) await this.assertManagedFolder(parentId, signal);
      const marker = JSON.stringify({ mapleBackupFolder: 1, rootId: this.rootId, path });
      const existing = [];
      for await (const child of this.client.list(
        `'${parentId}' in parents and trashed = false`,
        signal,
      ))
        if (child.name === name && child.mimeType === 'application/vnd.google-apps.folder')
          existing.push(child);
      if (existing.length > 1)
        throw new Error(`Multiple folders named ${name} exist in the Maple backup path.`);
      const folder = existing[0]
        ? existing[0].description === marker &&
          existing[0].parents?.[0] === parentId &&
          isOwnedMyDriveFile(existing[0])
          ? existing[0]
          : null
        : await this.client.json<{ id: string }>(
            `${DRIVE_API}/files?fields=id`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
                description: marker,
              }),
            },
            signal,
          );
      if (!folder)
        throw new Error(`The folder ${name} in the Maple backup path is not Maple-managed.`);
      const id = 'id' in folder ? folder.id : existing[0]!.id;
      this.folders.set(path, id);
      parentId = id;
    }
    return parentId;
  }
  async assertWithinRoot(file: DriveFile, signal?: AbortSignal): Promise<void> {
    if (file.parents?.length !== 1)
      throw new Error('Google backup object moved outside the owned backup folder.');
    const visited = new Set<string>();
    let parentId = file.parents[0]!;
    for (let depth = 0; parentId !== this.rootId; depth++) {
      if (depth >= 128 || visited.has(parentId))
        throw new Error('Google backup object has invalid folder ancestry.');
      visited.add(parentId);
      let parent: DriveFile;
      try {
        parent = await this.client.metadata(parentId, signal);
      } catch {
        throw new Error('Google backup object moved outside the owned backup folder.');
      }
      if (
        !isOwnedMyDriveFile(parent) ||
        parent.trashed ||
        parent.mimeType !== 'application/vnd.google-apps.folder' ||
        parent.parents?.length !== 1
      )
        throw new Error('Google backup object moved outside the owned backup folder.');
      parentId = parent.parents[0]!;
    }
  }
  private async assertManagedFolder(folderId: string, signal?: AbortSignal): Promise<void> {
    const folder = await this.client.metadata(folderId, signal);
    if (
      folder.mimeType !== 'application/vnd.google-apps.folder' ||
      folder.trashed ||
      !managedFolder(folder, this.rootId) ||
      !isOwnedMyDriveFile(folder)
    )
      throw new Error('Google backup folder moved outside the owned backup root.');
    await this.assertWithinRoot(folder, signal);
  }
  async *list(prefix: string, signal?: AbortSignal): AsyncIterable<BackupObject> {
    await this.probe(signal);
    const startFolder = await this.findFolders(listingFolderParts(prefix), signal);
    if (!startFolder) return;
    const queue = [startFolder];
    const visited = new Set<string>();
    while (queue.length) {
      const parents = queue.splice(0, 8);
      for (const parentId of parents) {
        if (visited.has(parentId)) throw new Error('Google backup folder tree contains a cycle.');
        visited.add(parentId);
      }
      const childrenByParent = await Promise.all(
        parents.map(async (parentId) => {
          if (parentId !== this.rootId) await this.assertManagedFolder(parentId, signal);
          const files: DriveFile[] = [];
          for await (const file of this.client.list(
            `'${parentId}' in parents and trashed = false`,
            signal,
          ))
            files.push(file);
          return files;
        }),
      );
      for (const children of childrenByParent) {
        for (const file of children) {
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            if (managedFolder(file, this.rootId)) queue.push(file.id);
            continue;
          }
          const marker = objectMarker(file);
          if (marker?.rootId === this.rootId && marker.key.startsWith(prefix))
            yield backupObject(file, this.rootId);
        }
      }
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
      await this.assertWithinRoot(await this.client.metadata(locator, signal), signal);
      return object;
    } catch (error) {
      if (isDriveStatus(error, 404)) return null;
      throw error;
    }
  }
  private async inspectIndex(key: string, signal?: AbortSignal): Promise<BackupObject | null> {
    const hash = logicalKeyHash(key);
    const matches: BackupObject[] = [];
    const relativePath = this.objectPath(key).split('/');
    relativePath.pop();
    const parentId = await this.findFolders(relativePath, signal);
    if (!parentId) return null;
    // 76 UTF-8 bytes total, below Drive's 124-byte public-property limit.
    // https://developers.google.com/workspace/drive/api/guides/search-files
    const query = `'${parentId}' in parents and trashed = false and properties has { key='mapleKeyHash' and value='${hash}' }`;
    for await (const file of this.client.list(query, signal)) {
      const object = backupObject(file, this.rootId);
      try {
        await this.assertWithinRoot(file, signal);
      } catch {
        continue;
      }
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
  async mirrorFile(
    key: string,
    relativePath: string,
    source: PublishSource,
    options: {
      signal?: AbortSignal;
      checkpoint?: UploadCheckpoint | null;
      saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
    },
  ): Promise<BackupObject> {
    validKey(key);
    const path = key.split('/').slice(2).join('/');
    if (!key.startsWith('mirror/') || path !== relativePath)
      throw new Error('Invalid Google mirror object key.');
    if (
      !Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    )
      throw new Error('Invalid Google mirror file identity.');
    await this.probe(options.signal);
    return publishGoogleMirrorFile(this, key, relativePath, source, options);
  }
  async download(object: BackupObject, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    await this.probe(signal);
    const current = backupObject(await this.client.metadata(object.locator, signal), this.rootId);
    await this.assertWithinRoot(await this.client.metadata(object.locator, signal), signal);
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
      await this.assertWithinRoot(await this.client.metadata(object.locator, signal), signal);
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
    if (state.replace) return;
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
      await this.assertWithinRoot(await this.client.metadata(expected.locator, signal), signal);
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
