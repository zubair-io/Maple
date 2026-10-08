import { createHash } from 'node:crypto';
import type { BackupObject, BackupProvider, PublishSource, UploadCheckpoint } from './provider.ts';

interface ProviderFixture extends BackupProvider {
  readonly objects: Map<string, { object: BackupObject; bytes: Uint8Array; moved: boolean }>;
  offline: boolean;
  beforePublish: ((key: string) => Promise<void>) | null;
}
/** A deterministic external object store for common engine conformance tests. */
export function createTestProvider(): ProviderFixture {
  const objects: ProviderFixture['objects'] = new Map();
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (provider.offline) throw new Error('Destination offline');
  };
  const provider: ProviderFixture = {
    objects,
    offline: false,
    beforePublish: null,
    async probe(signal?: AbortSignal) {
      check(signal);
    },
    async *list(prefix: string, signal?: AbortSignal) {
      check(signal);
      for (const row of objects.values())
        if (!row.moved && row.object.key.startsWith(prefix)) yield row.object;
    },
    async inspect(key: string, signal?: AbortSignal, locator?: string) {
      check(signal);
      const row = objects.get(key);
      if (row && locator && (row.moved || row.object.locator !== locator))
        throw new Error('Object outside root or identity changed');
      return row && !row.moved ? row.object : null;
    },
    async publish(
      key: string,
      source: PublishSource,
      options: {
        signal?: AbortSignal;
        checkpoint?: UploadCheckpoint | null;
        saveCheckpoint: (value: UploadCheckpoint) => Promise<void>;
      },
    ) {
      check(options.signal);
      await provider.beforePublish?.(key);
      const chunks: Uint8Array[] = [];
      for await (const chunk of source.open(0)) chunks.push(chunk);
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== source.size || hash !== source.sha256) throw new Error('Source changed');
      const existing = objects.get(key);
      if (existing && existing.object.sha256 !== hash) throw new Error('Immutable collision');
      const object = {
        key,
        locator: existing?.object.locator ?? crypto.randomUUID(),
        size: bytes.length,
        sha256: hash,
      };
      objects.set(key, { object, bytes, moved: false });
      return object;
    },
    async mirrorFile(
      key: string,
      _relativePath: string,
      source: PublishSource,
      options: {
        signal?: AbortSignal;
        checkpoint?: UploadCheckpoint | null;
        saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
      },
    ) {
      check(options.signal);
      await provider.beforePublish?.(key);
      const chunks: Uint8Array[] = [];
      for await (const chunk of source.open(0)) chunks.push(chunk);
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== source.size || hash !== source.sha256) throw new Error('Source changed');
      const existing = objects.get(key);
      if (existing?.moved) throw new Error('Object outside root');
      const object = {
        key,
        locator: existing?.object.locator ?? crypto.randomUUID(),
        size: bytes.length,
        sha256: hash,
      };
      objects.set(key, { object, bytes, moved: false });
      return object;
    },
    async download(object: BackupObject, signal?: AbortSignal) {
      check(signal);
      const row = objects.get(object.key);
      if (!row || row.object.locator !== object.locator || row.moved)
        throw new Error('Object unavailable or outside root');
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(row.bytes);
          controller.close();
        },
      });
    },
    async remove(object: BackupObject, signal?: AbortSignal) {
      check(signal);
      const row = objects.get(object.key);
      if (!row) return;
      if (row.moved || row.object.locator !== object.locator)
        throw new Error('Object outside root');
      objects.delete(object.key);
    },
    async abort(_checkpoint: UploadCheckpoint, signal?: AbortSignal) {
      check(signal);
    },
  };
  return provider;
}
