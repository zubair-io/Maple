import type {
  BackupInspectOptions,
  BackupObject,
  BackupProvider,
  PublishSource,
  UploadCheckpoint,
} from '../provider.ts';
import {
  DriveClient,
  DRIVE_API,
  isDriveStatus,
  isOwnedMyDriveFile,
  validateGoogleRoot,
  type DriveFile,
} from './client.ts';
import { publishGoogleObject, publishGoogleMirrorFile, parseCheckpoint } from './upload.ts';
import type { GoogleFetch } from './oauth.ts';
import { inspectGoogleObject } from './inspect.ts';
import { verifiedGoogleObject } from './integrity.ts';

import { objectMarker, backupObject, assertObjectIdentity } from './object.ts';

const folderCreationQueues = new Map<string, Promise<void>>();

async function serializeFolderCreation<T>(key: string, create: () => Promise<T>): Promise<T> {
  const previous = folderCreationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  folderCreationQueues.set(key, current);
  await previous;
  try {
    return await create();
  } finally {
    release();
    if (folderCreationQueues.get(key) === current) folderCreationQueues.delete(key);
  }
}

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
  async findObjectTarget(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ parentId: string; name: string } | null> {
    validKey(key);
    const parts = this.objectPath(key).split('/');
    const name = parts.pop()!;
    const parentId = await this.findFolders(parts, signal);
    return parentId ? { parentId, name } : null;
  }
  private objectPath(key: string): string {
    const mirrorParts = key.split('/');
    const relativePath =
      mirrorParts[0] === 'mirror' ? mirrorParts.slice(2).join('/') : `.maple-backup/${key}`;
    if (!relativePath) throw new Error('Invalid Google mirror path.');
    return relativePath;
  }
  private async resolveFolders(
    parts: string[],
    create: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
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
      const folderId = await this.resolveFolder(parentId, name, path, create, signal);
      if (!folderId) return null;
      this.folders.set(path, folderId);
      parentId = folderId;
    }
    return parentId;
  }
  private async resolveFolder(
    parentId: string,
    name: string,
    path: string,
    create: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const marker = JSON.stringify({
      mapleBackupFolder: 1,
      rootId: this.rootId,
      path,
    });
    const resolveExisting = async (): Promise<string | null> => {
      const matches = await this.matchingFolders(parentId, name, signal);
      if (matches.length > 1)
        throw new Error(`Multiple folders named ${name} exist in the Maple backup path.`);
      const existing = matches[0];
      if (!existing) return null;
      if (!this.matchesManagedFolder(existing, parentId, marker))
        throw new Error(`The folder ${name} in the Maple backup path is not Maple-managed.`);
      return existing.id;
    };
    const existing = await resolveExisting();
    if (existing || !create) return existing;
    return serializeFolderCreation(`${this.rootId}\0${parentId}\0${name}`, async () => {
      const afterWaiting = await resolveExisting();
      if (afterWaiting) return afterWaiting;
      const created = await this.client.json<{ id: string }>(
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
      return created.id;
    });
  }
  private async matchingFolders(
    parentId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<DriveFile[]> {
    const matches: DriveFile[] = [];
    for await (const child of this.client.list(
      `'${parentId}' in parents and trashed = false`,
      signal,
    ))
      if (child.name === name && child.mimeType === 'application/vnd.google-apps.folder')
        matches.push(child);
    return matches;
  }
  private matchesManagedFolder(file: DriveFile, parentId: string, marker: string): boolean {
    return (
      file.description === marker && file.parents?.[0] === parentId && isOwnedMyDriveFile(file)
    );
  }
  private async findFolders(parts: string[], signal?: AbortSignal): Promise<string | null> {
    return this.resolveFolders(parts, false, signal);
  }
  private async ensureFolders(parts: string[], signal?: AbortSignal): Promise<string> {
    const folderId = await this.resolveFolders(parts, true, signal);
    if (!folderId) throw new Error('Google backup folder could not be created.');
    return folderId;
  }
  private async parentWithinRoot(parentId: string, signal?: AbortSignal): Promise<string> {
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
    return parent.parents[0]!;
  }
  async assertWithinRoot(file: DriveFile, signal?: AbortSignal): Promise<void> {
    if (file.parents?.length !== 1)
      throw new Error('Google backup object moved outside the owned backup folder.');
    const visited = new Set<string>();
    let parentId = file.parents[0]!;
    while (parentId !== this.rootId) {
      if (visited.has(parentId) || visited.size >= 128)
        throw new Error('Google backup object has invalid folder ancestry.');
      visited.add(parentId);
      parentId = await this.parentWithinRoot(parentId, signal);
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
    for await (const file of this.managedFiles(startFolder, signal)) {
      const marker = objectMarker(file);
      if (marker?.rootId === this.rootId && marker.key.startsWith(prefix))
        yield backupObject(file, this.rootId);
    }
  }
  private async *managedFiles(startFolder: string, signal?: AbortSignal): AsyncIterable<DriveFile> {
    const queue = [startFolder];
    const visited = new Set<string>();
    while (queue.length) {
      const parents = queue.splice(0, 8);
      for (const parentId of parents) {
        if (visited.has(parentId)) throw new Error('Google backup folder tree contains a cycle.');
        visited.add(parentId);
      }
      const files = await this.listFolderBatch(parents, signal);
      this.enqueueManagedFolders(files, queue);
      for (const file of files)
        if (file.mimeType !== 'application/vnd.google-apps.folder') yield file;
    }
  }
  private async listFolderBatch(parents: string[], signal?: AbortSignal): Promise<DriveFile[]> {
    const children = await Promise.all(
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
    return children.flat();
  }
  private enqueueManagedFolders(files: DriveFile[], queue: string[]): void {
    for (const file of files)
      if (
        file.mimeType === 'application/vnd.google-apps.folder' &&
        managedFolder(file, this.rootId)
      )
        queue.push(file.id);
  }
  async inspect(
    key: string,
    signal?: AbortSignal,
    locatorOrOptions?: string | BackupInspectOptions,
    legacyHeartbeat?: (candidate: BackupObject) => Promise<void>,
  ): Promise<BackupObject | null> {
    const options =
      typeof locatorOrOptions === 'string'
        ? { locator: locatorOrOptions, heartbeat: legacyHeartbeat }
        : (locatorOrOptions ?? { heartbeat: legacyHeartbeat });
    validKey(key);
    await this.probe(signal);
    return inspectGoogleObject(this, key, options, signal);
  }
  async publish(
    key: string,
    source: PublishSource,
    options: {
      signal?: AbortSignal;
      checkpoint?: UploadCheckpoint | null;
      expected?: BackupObject | null;
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
      expected?: BackupObject | null;
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
  private async currentObjectMetadata(
    object: BackupObject,
    errorMessage: string,
    signal?: AbortSignal,
    hashWithoutNativeChecksum = false,
  ): Promise<BackupObject> {
    const file = await this.client.metadata(object.locator, signal);
    await this.assertWithinRoot(file, signal);
    const current = backupObject(file, this.rootId, object);
    // Drive's native checksum is the cheap drift detector. When it is absent
    // and the caller is about to destroy the object, hash the bytes instead of
    // trusting the database value alone.
    if (!file.sha256Checksum && hashWithoutNativeChecksum) {
      const actual = await verifiedGoogleObject(this, object, signal);
      assertObjectIdentity(actual, object, errorMessage);
      return actual;
    }
    const metadataIdentity = {
      ...current,
      size: Number(file.size),
      sha256: file.sha256Checksum ?? object.sha256,
    };
    assertObjectIdentity(metadataIdentity, object, errorMessage);
    return metadataIdentity;
  }
  async download(object: BackupObject, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    await this.probe(signal);
    // Consumers hash while streaming (catalog reads are bounded; restore
    // writes verify before publication). Avoid downloading the same bytes once
    // here and again for the caller when Drive omits its native checksum.
    await this.currentObjectMetadata(object, 'Backup object identity changed.', signal);
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
      await this.currentObjectMetadata(
        object,
        'Refusing removal of changed backup object.',
        signal,
        true,
      );
      await this.client.request(
        `${DRIVE_API}/files/${object.locator}`,
        { method: 'DELETE' },
        signal,
      );
    } catch (error) {
      if (!isDriveStatus(error, 404)) throw error;
    }
  }
  async abort(checkpoint: UploadCheckpoint, signal?: AbortSignal): Promise<BackupObject | null> {
    const state = parseCheckpoint(checkpoint, this.rootId);
    await this.probe(signal);
    await this.cancelSession(state.session, signal);
    if (state.replace) {
      const current = await this.inspect(state.key, signal, {
        locator: state.fileId,
        ...(state.key.startsWith('mirror/')
          ? {
              // A mirror checkpoint is local DB state. Use its locator to
              // inspect markerless files while checking whether the upload
              // completed before cancellation.
              expected: {
                key: state.key,
                locator: state.fileId,
                sha256: state.sha256,
                size: state.size,
              },
            }
          : {}),
      });
      return current?.sha256 === state.sha256 && current.size === state.size ? current : null;
    }
    // Cancellation precedes cleanup: a final chunk racing cancellation can
    // still have committed the reserved ID. Refuse any changed/moved object.
    await this.removeReservation(
      {
        key: state.key,
        locator: state.fileId,
        sha256: state.sha256,
        size: state.size,
      },
      signal,
    );
    await this.confirmMissing(state.fileId, signal);
    return null;
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
        expected,
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
