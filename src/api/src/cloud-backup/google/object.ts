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
export function backupObject(
  file: DriveFile,
  rootId: string,
  expected?: BackupObject,
): BackupObject {
  const marker = objectMarker(file);
  const databaseMappedMirror = Boolean(expected?.key.startsWith('mirror/'));
  if (!isOwnedMyDriveFile(file))
    throw new Error('Google backup object must remain owned by this account in My Drive.');
  // A database mapping is authoritative for a known mirror object. Google
  // metadata is mutable and may lose its descriptive marker; never make the
  // file unrecognizable just because that redundant hint was edited.
  if (!databaseMappedMirror && !marker)
    throw invalidObject('backup marker is missing or malformed');
  if (!databaseMappedMirror && marker?.rootId !== rootId)
    throw invalidObject('backup marker belongs to a different root');
  if (file.trashed) throw invalidObject('file is in Drive Trash');
  if (file.mimeType === 'application/vnd.google-apps.shortcut')
    throw invalidObject('shortcuts cannot be backup objects');
  if (file.parents?.length !== 1) throw invalidObject('file does not have exactly one parent');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0)
    throw invalidObject('file size is missing or invalid');
  if (
    !databaseMappedMirror &&
    marker &&
    file.sha256Checksum &&
    file.sha256Checksum !== marker.sha256
  )
    throw invalidObject('Google’s checksum does not match the backup marker');
  if (expected && expected.key && expected.locator !== file.id)
    throw invalidObject('database object mapping does not match the Drive file');
  if (
    !databaseMappedMirror &&
    expected &&
    (marker?.key !== expected.key || marker.sha256 !== expected.sha256)
  )
    throw invalidObject('database object mapping does not match the backup marker');
  return {
    key: databaseMappedMirror ? expected!.key : marker!.key,
    locator: file.id,
    size,
    sha256: databaseMappedMirror ? expected!.sha256 : marker!.sha256,
  };
}
function invalidObject(reason: string): Error {
  return new Error(`Google object failed identity or integrity validation: ${reason}.`);
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
