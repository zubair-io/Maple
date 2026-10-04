import { createHash } from 'node:crypto';
import type { BackupObject, BackupProvider, PublishSource, UploadCheckpoint } from './provider.ts';

/** A deterministic external object store for common engine conformance tests. */
export class TestProvider implements BackupProvider {
  readonly objects = new Map<string, { object: BackupObject; bytes: Uint8Array; moved: boolean }>();
  offline = false;
  beforePublish: ((key: string) => Promise<void>) | null = null;
  check(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.offline) throw new Error('Destination offline');
  }
  async probe(signal?: AbortSignal) {
    this.check(signal);
  }
  async *list(prefix: string, signal?: AbortSignal) {
    this.check(signal);
    for (const row of this.objects.values())
      if (!row.moved && row.object.key.startsWith(prefix)) yield row.object;
  }
  async inspect(key: string, signal?: AbortSignal, locator?: string) {
    this.check(signal);
    const row = this.objects.get(key);
    if (row && locator && (row.moved || row.object.locator !== locator))
      throw new Error('Object outside root or identity changed');
    return row && !row.moved ? row.object : null;
  }
  async publish(
    key: string,
    source: PublishSource,
    options: {
      signal?: AbortSignal;
      checkpoint?: UploadCheckpoint | null;
      saveCheckpoint: (value: UploadCheckpoint) => Promise<void>;
    },
  ) {
    this.check(options.signal);
    await this.beforePublish?.(key);
    const chunks: Uint8Array[] = [];
    for await (const chunk of source.open(0)) chunks.push(chunk);
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== source.size || hash !== source.sha256) throw new Error('Source changed');
    const existing = this.objects.get(key);
    if (existing && existing.object.sha256 !== hash) throw new Error('Immutable collision');
    const object = {
      key,
      locator: existing?.object.locator ?? crypto.randomUUID(),
      size: bytes.length,
      sha256: hash,
    };
    this.objects.set(key, { object, bytes, moved: false });
    return object;
  }
  async download(object: BackupObject, signal?: AbortSignal) {
    this.check(signal);
    const row = this.objects.get(object.key);
    if (!row || row.object.locator !== object.locator || row.moved)
      throw new Error('Object unavailable or outside root');
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(row.bytes);
        controller.close();
      },
    });
  }
  async remove(object: BackupObject, signal?: AbortSignal) {
    this.check(signal);
    const row = this.objects.get(object.key);
    if (!row) return;
    if (row.moved || row.object.locator !== object.locator) throw new Error('Object outside root');
    this.objects.delete(object.key);
  }
  async abort(_checkpoint: UploadCheckpoint, signal?: AbortSignal) {
    this.check(signal);
  }
}
