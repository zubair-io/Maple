import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { BackupRepository, type BackupDestination, type BackupEntry } from './repository.ts';
import {
  assetInventory,
  captureInventory,
  validateCapture,
  releaseCapture,
  type InventoryLocation,
} from './inventory.ts';
import { startEntryLease } from './entry-lease.ts';
import type {
  BackupManifest,
  BackupObject,
  BackupProvider,
  PublishSource,
  UploadCheckpoint,
} from './provider.ts';

export function jsonSource(value: unknown): PublishSource {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return {
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    open: (offset) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(data.slice(offset));
          controller.close();
        },
      }),
  };
}
export function entryPrefix(libraryId: string, entryId: string): string {
  return `libraries/${libraryId}/entries/${entryId}/`;
}
export type ProviderFactory = (destination: BackupDestination) => Promise<BackupProvider>;

type CapturedFiles = Awaited<ReturnType<typeof captureInventory>>;
interface TransferContext {
  destination: BackupDestination;
  entry: BackupEntry;
  owner: string;
  provider: BackupProvider;
  signal: AbortSignal;
}
interface UploadCallOptions {
  signal?: AbortSignal;
  checkpoint?: UploadCheckpoint | null;
  saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
}
type UploadCall = (options: UploadCallOptions) => Promise<BackupObject>;
function lifecycleMetadata(location: InventoryLocation) {
  const state = location.relative_path.startsWith('.maple/trash/')
    ? ('trash' as const)
    : ('active' as const);
  const originalPath =
    state === 'trash' && location.original_path
      ? path.relative(location.root, location.original_path).split(path.sep).join('/')
      : location.relative_path;
  return {
    state,
    originalPath,
    deletedAt: state === 'trash' ? location.deleted_at : null,
    hidden: Boolean(location.hidden),
  };
}
function snapshotHash(location: InventoryLocation, files: CapturedFiles): string {
  const { state, originalPath, deletedAt, hidden } = lifecycleMetadata(location);
  return jsonSource({
    state,
    originalPath,
    path: location.relative_path,
    deletedAt,
    hidden,
    files: files.map((file) => [file.path, file.role, file.source.sha256, file.source.size]),
  }).sha256;
}
function sameObjectIdentity(
  object: BackupObject | null | undefined,
  expected: BackupObject,
): boolean {
  return Boolean(
    object &&
    object.key === expected.key &&
    object.locator === expected.locator &&
    object.sha256 === expected.sha256 &&
    object.size === expected.size,
  );
}
async function removeStaleEntryObject(
  provider: BackupProvider,
  repo: BackupRepository,
  destination: BackupDestination,
  entry: BackupEntry,
  expected: BackupObject,
  signal: AbortSignal,
): Promise<void> {
  const mirrorKey = expected.key.startsWith(`mirror/${destination.libraryId}/`);
  const legacyKey =
    expected.key ===
    `libraries/${destination.libraryId}/entries/${entry.id}/blobs/${expected.sha256}`;
  if (!mirrorKey && !legacyKey) return;
  const owner = await repo.objectOwner(destination.id, expected.key);
  if (owner?.entryId !== entry.id || !sameObjectIdentity(owner.object, expected)) return;
  const current = await provider.inspect(expected.key, signal, expected.locator);
  if (!sameObjectIdentity(current, expected)) return;
  const stillOwned = await repo.objectOwner(destination.id, expected.key);
  if (stillOwned?.entryId !== entry.id || !sameObjectIdentity(stillOwned.object, expected)) return;
  await provider.remove(current!, signal);
  await repo.forgetObject(destination.id, current!.key, current!.locator);
}
export class BackupEngine {
  constructor(
    readonly provider: ProviderFactory,
    readonly repo: BackupRepository = new BackupRepository(),
  ) {}
  /** A completed sequence needs no source reads or provider calls on another target's retry. */
  private async verifiedCurrent(
    entry: BackupEntry,
    destination: BackupDestination,
  ): Promise<boolean> {
    const rows = await this.repo.db.read<{ id: string }>(
      `SELECT e.id FROM backup_entries e JOIN backup_destinations d ON d.id=e.destination_id
      WHERE e.id=? AND e.sequence=? AND e.verified_sequence=e.sequence AND e.state!='purged'
      AND d.id=? AND d.enabled=1 AND d.generation=? AND d.root_id IS ? AND d.account_id IS ?
      AND NOT EXISTS (SELECT 1 FROM backup_lifecycle l WHERE l.asset_id=e.asset_id
        AND ((l.phase='prepared' AND l.library_id=d.library_id) OR l.kind='purge'))`,
      [
        entry.id,
        entry.sequence,
        destination.id,
        destination.generation,
        destination.rootId,
        destination.accountId,
      ],
    );
    return rows.length > 0;
  }
  async publish(
    provider: BackupProvider,
    destination: BackupDestination,
    entry: BackupEntry,
    key: string,
    source: PublishSource,
    signal?: AbortSignal,
  ): Promise<BackupObject> {
    const saved = await this.repo.object(destination.id, key);
    const existing = await provider.inspect(key, signal, saved.object?.locator);
    if (existing) {
      if (existing.size !== source.size || existing.sha256 !== source.sha256)
        throw new Error('Backup immutable object integrity mismatch');
      await this.repo.saveObject(destination.id, entry.id, key, existing, null);
      return existing;
    }
    return this.uploadObject(
      destination,
      entry,
      key,
      source,
      saved.checkpoint,
      (options) => provider.publish(key, source, options),
      'Backup transfer',
      signal,
    );
  }
  private async mirrorFile(
    provider: BackupProvider,
    destination: BackupDestination,
    entry: BackupEntry,
    key: string,
    relativePath: string,
    source: PublishSource,
    signal?: AbortSignal,
  ): Promise<BackupObject> {
    const saved = await this.repo.object(destination.id, key);
    return this.uploadObject(
      destination,
      entry,
      key,
      source,
      saved.checkpoint,
      (options) => provider.mirrorFile(key, relativePath, source, options),
      'Backup mirror',
      signal,
    );
  }
  private async uploadObject(
    destination: BackupDestination,
    entry: BackupEntry,
    key: string,
    source: PublishSource,
    checkpoint: UploadCheckpoint | null,
    upload: UploadCall,
    label: string,
    signal?: AbortSignal,
  ): Promise<BackupObject> {
    const object = await upload({
      signal,
      checkpoint,
      saveCheckpoint: async (value) => {
        await this.repo.saveObject(destination.id, entry.id, key, null, value);
        if (!entry.lease_owner || !(await this.repo.fence(entry, destination, entry.lease_owner)))
          throw new Error('Backup lifecycle changed during upload');
      },
    });
    if (object.size !== source.size || object.sha256 !== source.sha256)
      throw new Error(`${label} integrity mismatch`);
    await this.repo.saveObject(destination.id, entry.id, key, object, null);
    return object;
  }
  private async assertFence(ctx: TransferContext, message: string): Promise<void> {
    if (!(await this.repo.fence(ctx.entry, ctx.destination, ctx.owner))) throw new Error(message);
  }
  private async publishFiles(
    ctx: TransferContext,
    files: CapturedFiles,
  ): Promise<BackupManifest['files']> {
    const objects: BackupManifest['files'] = [];
    for (const file of files) {
      ctx.signal.throwIfAborted();
      await this.assertFence(ctx, 'Backup lease or lifecycle changed');
      const key = `mirror/${ctx.destination.libraryId}/${file.path}`;
      const object = await this.mirrorFile(
        ctx.provider,
        ctx.destination,
        ctx.entry,
        key,
        file.path,
        file.source,
        ctx.signal,
      );
      objects.push({ path: file.path, role: file.role, object });
    }
    return objects;
  }
  private async validateCurrentInventory(
    ctx: TransferContext,
    location: InventoryLocation,
    files: CapturedFiles,
  ): Promise<void> {
    await validateCapture(location, files, ctx.signal);
    const current = (
      await assetInventory(location.asset_id, ctx.destination.libraryId, this.repo)
    ).find((item) => item.ordinal === location.ordinal);
    if (!current || JSON.stringify(current) !== JSON.stringify(location))
      throw new Error('Backup asset changed before catalog publication');
    await this.assertFence(ctx, 'Backup asset changed before catalog publication');
  }
  private async publishCatalog(
    ctx: TransferContext,
    location: InventoryLocation,
    files: BackupManifest['files'],
  ): Promise<boolean> {
    const { destination, entry, provider, signal } = ctx;
    const repo: BackupRepository = this.repo;
    const { state, originalPath, deletedAt, hidden } = lifecycleMetadata(location);
    const manifest: BackupManifest = {
      version: 1,
      libraryId: destination.libraryId,
      entryId: entry.id,
      assetId: location.asset_id,
      sequence: entry.sequence,
      state,
      originalPath,
      currentPath: location.relative_path,
      deletedAt,
      hidden,
      files,
    };
    await this.publish(
      provider,
      destination,
      entry,
      `libraries/${destination.libraryId}/descriptor.json`,
      jsonSource({
        version: 1,
        libraryId: destination.libraryId,
        format: 'maple-photo-backup',
      }),
      signal,
    );
    await this.publish(
      provider,
      destination,
      entry,
      `${entryPrefix(destination.libraryId, entry.id)}manifests/${entry.sequence}.json`,
      jsonSource(manifest),
      signal,
    );
    for await (const oldManifest of provider.list(
      `${entryPrefix(destination.libraryId, entry.id)}manifests/`,
      signal,
    )) {
      if (
        oldManifest.key !==
        `${entryPrefix(destination.libraryId, entry.id)}manifests/${entry.sequence}.json`
      )
        await provider.remove(oldManifest, signal);
    }
    const previous = entry.manifest ? (JSON.parse(entry.manifest) as BackupManifest) : null;
    const retainedKeys = new Set(files.map((file) => file.object.key));
    const previousObjects = new Map(
      (previous?.files ?? []).map((file) => [file.object.key, file.object]),
    );
    for (const oldObject of await repo.objectsForEntry(destination.id, entry.id)) {
      previousObjects.set(oldObject.key, oldObject);
    }
    for (const oldObject of previousObjects.values()) {
      if (retainedKeys.has(oldObject.key)) continue;
      await removeStaleEntryObject(provider, repo, destination, entry, oldObject, signal);
    }
    await this.assertFence(ctx, 'Backup changed during catalog publication');
    return repo.finish(entry, destination, ctx.owner, manifest);
  }
  async transfer(
    destination: BackupDestination,
    location: InventoryLocation,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const repo: BackupRepository = this.repo;
    const initial = await repo.ensureEntry(
      destination.id,
      location.asset_id,
      location.ordinal,
      location.relative_path,
    );
    if (signal?.aborted) return false;
    if (initial.verified_sequence === initial.sequence)
      return this.verifiedCurrent(initial, destination);
    const owner = crypto.randomUUID();
    if (initial.state === 'purged' || !(await repo.claim(initial, owner))) return false;
    const lease = startEntryLease(repo, destination, initial, owner, signal);
    let files: CapturedFiles | undefined;
    try {
      files = await captureInventory(location, lease.signal);
      const entry = await repo.reserveSnapshot(initial, owner, snapshotHash(location, files));
      lease.update(entry);
      if (!(await repo.fence(entry, destination, owner)))
        throw new Error('Backup configuration or lifecycle changed');
      const provider = await this.provider(destination);
      await provider.probe(lease.signal);
      const ctx = { destination, entry, owner, provider, signal: lease.signal };
      const objects = await this.publishFiles(ctx, files);
      await this.validateCurrentInventory(ctx, location, files);
      return await this.publishCatalog(ctx, location, objects);
    } catch (error) {
      await repo.fail(
        initial,
        owner,
        error instanceof Error ? error.message : 'Backup transfer failed',
      );
      return false;
    } finally {
      lease.stop();
      if (files) await releaseCapture(files);
    }
  }
  async backupAsset(assetId: string, signal?: AbortSignal): Promise<boolean> {
    const destinations = (await this.repo.destinations()).filter(
      (d) => d.kind === 'google-drive' && d.enabled,
    );
    const results: boolean[] = [];
    for (const destination of destinations) {
      const locations = await assetInventory(assetId, destination.libraryId, this.repo);
      for (const location of locations)
        results.push(await this.transfer(destination, location, signal));
    }
    return results.length > 0 && results.every(Boolean);
  }
}
