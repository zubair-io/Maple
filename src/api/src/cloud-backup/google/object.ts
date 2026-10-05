import type { BackupObject } from '../provider.ts';
import { isOwnedMyDriveFile, type DriveFile } from './client.ts';

interface ObjectMarker {
  mapleBackupObject: 1;
  rootId: string;
  key: string;
  sha256: string;
}
export function objectMarker(file: DriveFile): ObjectMarker | null {
  try {
    const marker = JSON.parse(file.description ?? '{}') as ObjectMarker;
    return marker.mapleBackupObject === 1 &&
      typeof marker.rootId === 'string' &&
      typeof marker.key === 'string' &&
      /^[a-f0-9]{64}$/.test(marker.sha256)
      ? marker
      : null;
  } catch {
    return null;
  }
}
export function backupObject(file: DriveFile, rootId: string): BackupObject {
  const marker = objectMarker(file);
  if (!isOwnedMyDriveFile(file))
    throw new Error('Google backup object must remain owned by this account in My Drive.');
  if (
    !marker ||
    marker.rootId !== rootId ||
    file.trashed ||
    file.mimeType === 'application/vnd.google-apps.shortcut' ||
    file.parents?.length !== 1 ||
    file.parents[0] !== rootId ||
    !Number.isSafeInteger(Number(file.size)) ||
    Number(file.size) < 0 ||
    (file.sha256Checksum && file.sha256Checksum !== marker.sha256)
  ) {
    throw new Error(
      'Google object moved outside the owned backup folder or failed integrity validation.',
    );
  }
  return { key: marker.key, locator: file.id, size: Number(file.size), sha256: marker.sha256 };
}
export function assertObjectIdentity(
  actual: BackupObject,
  expected: BackupObject,
  message: string,
): void {
  if (
    actual.key !== expected.key ||
    actual.sha256 !== expected.sha256 ||
    actual.size !== expected.size
  )
    throw new Error(message);
}
