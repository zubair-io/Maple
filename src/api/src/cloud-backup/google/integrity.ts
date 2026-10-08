import { createHash } from 'node:crypto';
import type { BackupObject } from '../provider.ts';
import type { GoogleDriveProvider } from './provider.ts';
import { backupObject, assertObjectIdentity } from './object.ts';

export async function verifiedGoogleObject(
  provider: GoogleDriveProvider,
  expected: BackupObject,
  signal?: AbortSignal,
  heartbeat?: () => Promise<void>,
): Promise<BackupObject> {
  await heartbeat?.();
  const file = await provider.client.metadata(expected.locator, signal);
  await provider.assertWithinRoot(file, signal);
  const object = backupObject(file, provider.rootId);
  assertObjectIdentity(object, expected, 'Google immutable upload conflicted.');
  await heartbeat?.();
  if (file.sha256Checksum) return object;
  const reader = (await provider.download(object, signal)).getReader();
  const hash = createHash('sha256');
  let size = 0;
  let renewedAt = Date.now();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      hash.update(result.value);
      size += result.value.length;
      if (heartbeat && Date.now() - renewedAt > 10_000) {
        await heartbeat();
        renewedAt = Date.now();
      }
    }
  } finally {
    await reader.cancel();
  }
  if (hash.digest('hex') !== expected.sha256 || size !== expected.size)
    throw new Error('Google upload read-back checksum mismatch.');
  return object;
}
