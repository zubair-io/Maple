import { createHash } from 'node:crypto';
import type { BackupObject } from '../provider.ts';
import type { GoogleDriveProvider } from './provider.ts';
import { DRIVE_API } from './client.ts';
import { backupObject, ObjectIdentityError } from './object.ts';

export async function verifiedGoogleObject(
  provider: GoogleDriveProvider,
  expected: BackupObject,
  signal?: AbortSignal,
  heartbeat?: () => Promise<void>,
): Promise<BackupObject> {
  await heartbeat?.();
  const file = await provider.client.metadata(expected.locator, signal);
  await provider.assertWithinRoot(file, signal);
  const object = backupObject(file, provider.rootId, expected);
  await heartbeat?.();
  if (file.sha256Checksum) {
    const actual = { ...object, size: Number(file.size), sha256: file.sha256Checksum };
    if (!expected.key.startsWith('mirror/')) assertExpectedIdentity(actual, expected);
    return actual;
  }
  // The media read bypasses download(); revalidate the configured root
  // first so bytes are never hashed out of a root that was trashed or
  // re-marked after the metadata read.
  await provider.probe(signal);
  const response = await provider.client.request(
    `${DRIVE_API}/files/${expected.locator}?alt=media`,
    {},
    signal,
  );
  if (!response.body) throw new Error('Google returned no object bytes.');
  const reader = response.body.getReader();
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
  const actual = { ...object, size, sha256: hash.digest('hex') };
  if (!expected.key.startsWith('mirror/')) assertExpectedIdentity(actual, expected);
  return actual;
}
function assertExpectedIdentity(actual: BackupObject, expected: BackupObject): void {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
    throw new ObjectIdentityError('Google upload read-back checksum mismatch.');
}
