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
import type { BackupManifest, BackupObject, BackupProvider, PublishSource } from './provider.ts';

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

export class BackupEngine {
  constructor(
    readonly provider: ProviderFactory,
    readonly repo = new BackupRepository(),
  ) {}
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
    const object = await provider.publish(key, source, {
      signal,
      checkpoint: saved.checkpoint,
      saveCheckpoint: async (checkpoint) => {
        await this.repo.saveObject(destination.id, entry.id, key, null, checkpoint);
        if (!entry.lease_owner || !(await this.repo.fence(entry, destination, entry.lease_owner)))
          throw new Error('Backup lifecycle changed during upload');
      },
    });
    if (object.size !== source.size || object.sha256 !== source.sha256)
      throw new Error('Backup transfer integrity mismatch');
    await this.repo.saveObject(destination.id, entry.id, key, object, null);
    return object;
  }
  async transfer(
    destination: BackupDestination,
    location: InventoryLocation,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const initial = await this.repo.ensureEntry(
      destination.id,
      location.asset_id,
      location.ordinal,
      location.relative_path,
    );
    const owner = crypto.randomUUID();
    if (initial.state === 'purged' || !(await this.repo.claim(initial, owner))) return false;
    const leaseAbort = new AbortController();
    const transferSignal = signal
      ? AbortSignal.any([signal, leaseAbort.signal])
      : leaseAbort.signal;
    let leasedEntry = initial;
    let files: Awaited<ReturnType<typeof captureInventory>> | undefined;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.repo
        .fence(leasedEntry, destination, owner)
        .then((valid) => {
          if (!valid) leaseAbort.abort(new Error('Backup lease or configuration changed'));
        })
        .catch(() => leaseAbort.abort(new Error('Backup lease renewal failed')))
        .finally(() => {
          renewing = false;
        });
    }, 20_000);
    try {
      files = await captureInventory(location, transferSignal);
      const state = location.relative_path.startsWith('.maple/trash/')
        ? ('trash' as const)
        : ('active' as const);
      const originalPath =
        state === 'trash' && location.original_path
          ? path.relative(location.root, location.original_path).split(path.sep).join('/')
          : location.relative_path;
      const snapshot = jsonSource({
        state,
        originalPath,
        path: location.relative_path,
        deletedAt: state === 'trash' ? location.deleted_at : null,
        hidden: Boolean(location.hidden),
        files: files.map((f) => [f.path, f.role, f.source.sha256, f.source.size]),
      });
      const entry = await this.repo.reserveSnapshot(initial, owner, snapshot.sha256);
      leasedEntry = entry;
      if (!(await this.repo.fence(entry, destination, owner)))
        throw new Error('Backup configuration or lifecycle changed');
      const provider = await this.provider(destination);
      await provider.probe(transferSignal);
      const prefix = entryPrefix(destination.libraryId, entry.id);
      const objects: BackupManifest['files'] = [];
      for (const file of files) {
        transferSignal.throwIfAborted();
        if (!(await this.repo.fence(entry, destination, owner)))
          throw new Error('Backup lease or lifecycle changed');
        const object = await this.publish(
          provider,
          destination,
          entry,
          `${prefix}blobs/${file.source.sha256}`,
          file.source,
          transferSignal,
        );
        objects.push({ path: file.path, role: file.role, object });
      }
      await validateCapture(location, files, transferSignal);
      const current = (
        await assetInventory(location.asset_id, destination.libraryId, this.repo)
      ).find((item) => item.ordinal === location.ordinal);
      if (
        !current ||
        JSON.stringify(current) !== JSON.stringify(location) ||
        !(await this.repo.fence(entry, destination, owner))
      ) {
        throw new Error('Backup asset changed before catalog publication');
      }
      const manifest: BackupManifest = {
        version: 1,
        libraryId: destination.libraryId,
        entryId: entry.id,
        assetId: location.asset_id,
        sequence: entry.sequence,
        state,
        originalPath,
        currentPath: location.relative_path,
        deletedAt: state === 'trash' ? location.deleted_at : null,
        hidden: Boolean(location.hidden),
        files: objects,
      };
      await this.publish(
        provider,
        destination,
        entry,
        `libraries/${destination.libraryId}/descriptor.json`,
        jsonSource({ version: 1, libraryId: destination.libraryId, format: 'maple-photo-backup' }),
        transferSignal,
      );
      await this.publish(
        provider,
        destination,
        entry,
        `${prefix}manifests/${entry.sequence}.json`,
        jsonSource(manifest),
        transferSignal,
      );
      if (!(await this.repo.fence(entry, destination, owner)))
        throw new Error('Backup changed during catalog publication');
      return await this.repo.finish(entry, destination, owner, manifest);
    } catch (error) {
      await this.repo.fail(
        initial,
        owner,
        error instanceof Error ? error.message : 'Backup transfer failed',
      );
      return false;
    } finally {
      clearInterval(heartbeat);
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
