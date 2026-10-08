import { mkdtemp, realpath, rm } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ObjectId } from '../db/object-id.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import type { BackupManifest, BackupObject, BackupProvider } from './provider.ts';
import type { JobHandlerContext } from '../job-runner/handlers/index.ts';
export const libraryId = 'a'.repeat(24),
  entryId = 'b'.repeat(24);
const assetId = 'c'.repeat(24);
export const source = {
  destinationId: 'destination',
  rootId: 'google-root',
  accountId: 'google-account',
};
class MemoryProvider implements BackupProvider {
  objects = new Map<string, { object: BackupObject; bytes: Uint8Array }>();
  downloads: string[] = [];
  lists: string[] = [];
  inspections: string[] = [];
  stallKey: string | null = null;
  cancelled = false;
  put(key: string, value: string): BackupObject {
    const bytes = new TextEncoder().encode(value);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const actualKey = key.includes('/blobs/')
      ? key.slice(0, key.indexOf('/blobs/') + 7) + sha256
      : key;
    const object = {
      key: actualKey,
      locator: actualKey,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    this.objects.set(actualKey, { object, bytes });
    return object;
  }
  manifest(sequence = 1, state: 'active' | 'trash' = 'active', id = entryId): BackupManifest {
    const name = state === 'trash' ? '.maple/trash/photo.jpg' : 'photo.jpg';
    const object = this.put(`mirror/${libraryId}/${name}`, `${id}-version-${sequence}`);
    const manifest: BackupManifest = {
      version: 1,
      libraryId,
      entryId: id,
      assetId,
      sequence,
      state,
      originalPath: 'photo.jpg',
      currentPath: name,
      deletedAt: state === 'trash' ? '2026-10-04T00:00:00Z' : null,
      hidden: false,
      files: [{ path: name, role: 'original', object }],
    };
    this.saveManifest(manifest);
    return manifest;
  }
  saveManifest(manifest: BackupManifest) {
    const prefix = `libraries/${manifest.libraryId}/entries/${manifest.entryId}/manifests/`;
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) this.objects.delete(key);
    this.put(`${prefix}${manifest.sequence}.json`, JSON.stringify(manifest));
  }
  async probe() {}
  async *list(prefix: string) {
    this.lists.push(prefix);
    for (const row of this.objects.values())
      if (row.object.key.startsWith(prefix)) yield row.object;
  }
  async inspect(key: string) {
    this.inspections.push(key);
    return this.objects.get(key)?.object ?? null;
  }
  async download(object: BackupObject) {
    this.downloads.push(object.key);
    if (object.key === this.stallKey)
      return new ReadableStream<Uint8Array>({
        cancel: () => {
          this.cancelled = true;
        },
      });
    const bytes = this.objects.get(object.key)!.bytes;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  async publish(): Promise<BackupObject> {
    throw new Error('Read-only recovery test provider');
  }
  async mirrorFile(): Promise<BackupObject> {
    throw new Error('Read-only recovery test provider');
  }
  async remove(object: BackupObject) {
    this.objects.delete(object.key);
  }
  async abort() {}
}
export async function recoveryFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-recovery-')));
  registerRoot(root);
  const live = await createLiveTestDatabase();
  const provider = new MemoryProvider();
  const jobId = new ObjectId();
  let checkpoint: Record<string, unknown> | undefined;
  const ctx: JobHandlerContext = {
    jobId,
    saveCheckpoint: async (value) => {
      checkpoint = value;
    },
    shouldCancel: async () => false,
    reportProgress: async () => {},
  };
  return {
    root,
    live,
    provider,
    ctx,
    request: { targetPath: root, includeTrash: true },
    checkpoint: () => checkpoint,
    async close() {
      live.close();
      unregisterRoot(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function publishTestPurge(
  provider: MemoryProvider,
  id = entryId,
  library = libraryId,
  recordEntry = id,
) {
  return provider.put(
    `purges/${id}.json`,
    JSON.stringify({
      version: 1,
      libraryId: library,
      entryId: recordEntry,
      sequence: 2,
      purgedAt: '2026-10-04T00:00:00Z',
    }),
  );
}
