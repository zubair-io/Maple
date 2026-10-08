import { createHash } from 'node:crypto';
import type { BackupObject, BackupProvider, PublishSource, UploadCheckpoint } from './provider.ts';

async function sourceBytes(source: PublishSource): Promise<{ bytes: Uint8Array; hash: string }> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.open(0)) chunks.push(chunk);
  const bytes = new Uint8Array(Buffer.concat(chunks));
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

interface StoredObject {
  object: BackupObject;
  bytes: Uint8Array;
  moved: boolean;
}
interface ProviderFixture extends BackupProvider {
  readonly objects: Map<string, StoredObject>;
  offline: boolean;
  beforePublish: ((key: string) => Promise<void>) | null;
}
function checkDestination(provider: ProviderFixture, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (provider.offline) throw new Error('Destination offline');
}
async function verifiedSource(source: PublishSource): Promise<{ bytes: Uint8Array; hash: string }> {
  const content = await sourceBytes(source);
  if (content.bytes.length !== source.size || content.hash !== source.sha256)
    throw new Error('Source changed');
  return content;
}
function saveSource(
  objects: ProviderFixture['objects'],
  key: string,
  bytes: Uint8Array,
  hash: string,
  replace: boolean,
): BackupObject {
  const existing = objects.get(key);
  if (replace && existing?.moved) throw new Error('Object outside root');
  if (!replace && existing && existing.object.sha256 !== hash)
    throw new Error('Immutable collision');
  const object = {
    key,
    locator: existing?.object.locator ?? crypto.randomUUID(),
    size: bytes.length,
    sha256: hash,
  };
  objects.set(key, { object, bytes, moved: false });
  return object;
}
async function putSource(
  provider: ProviderFixture,
  objects: ProviderFixture['objects'],
  key: string,
  source: PublishSource,
  signal: AbortSignal | undefined,
  replace: boolean,
): Promise<BackupObject> {
  checkDestination(provider, signal);
  await provider.beforePublish?.(key);
  const { bytes, hash } = await verifiedSource(source);
  return saveSource(objects, key, bytes, hash, replace);
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
      return putSource(provider, objects, key, source, options.signal, false);
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
      return putSource(provider, objects, key, source, options.signal, true);
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
      return null;
    },
  };
  return provider;
}
