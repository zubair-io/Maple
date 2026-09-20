import { chmod, link, mkdtemp, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspectSnapshot } from './backup-snapshot.ts';

export async function verifyBackup(response: Response, target: string): Promise<void> {
  const checksum = response.headers.get('x-amz-meta-sha256');
  const size = Number(response.headers.get('x-amz-meta-uncompressed-size'));
  if (
    !response.body ||
    !checksum ||
    !/^[a-f0-9]{64}$/.test(checksum) ||
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    await response.body?.cancel();
    throw new Error('Backup metadata is missing or invalid');
  }
  let bytes = 0;
  const limited = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > size) throw new Error('Backup exceeds declared size');
      controller.enqueue(chunk);
    },
  });
  await Bun.write(
    target,
    new Response(response.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(limited)),
  );
  await chmod(target, 0o600);
  const info = await inspectSnapshot(target);
  if (bytes !== size || info.sha256 !== checksum)
    throw new Error('Backup checksum or size mismatch');
  if (info.schema !== response.headers.get('x-amz-meta-schema-version'))
    throw new Error('Backup schema metadata mismatch');
}

export async function restoreBackup(response: Response, target: string): Promise<void> {
  const directory = await mkdtemp(join(dirname(target), '.maple-restore-'));
  try {
    for (const path of [target, `${target}-wal`, `${target}-shm`]) {
      try {
        await access(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error(
        `Restore target already exists: ${path}. Stop Maple and move the database and WAL/SHM aside first.`,
      );
    }
    const staged = join(directory, 'maple.db');
    await verifyBackup(response, staged);
    // link publishes atomically without overwriting a concurrently created database.
    await link(staged, target);
  } finally {
    await response.body?.cancel().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
