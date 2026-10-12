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
  const databaseMappedMirror = expected?.key.startsWith('mirror/') ?? false;
  if (!isOwnedMyDriveFile(file))
    throw new Error('Google backup object must remain owned by this account in My Drive.');
  // A database mapping is authoritative for a known mirror object. Google
  // metadata is mutable and may lose its descriptive marker; never make the
  // file unrecognizable just because that redundant hint was edited.
  const size = validateDriveFile(file);
  if (databaseMappedMirror) {
    if (!expected) throw invalidObject('database mirror mapping is missing');
    return databaseMappedObject(file, expected);
  }
  const portable = validatePortableIdentity(file, marker, rootId, expected);
  return {
    key: portable.key,
    locator: file.id,
    size,
    sha256: portable.sha256,
  };
}
function validateDriveFile(file: DriveFile): number {
  if (file.trashed) throw invalidObject('file is in Drive Trash');
  if (file.mimeType === 'application/vnd.google-apps.shortcut')
    throw invalidObject('shortcuts cannot be backup objects');
  if (file.parents?.length !== 1) throw invalidObject('file does not have exactly one parent');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0)
    throw invalidObject('file size is missing or invalid');
  return size;
}
function databaseMappedObject(file: DriveFile, expected: BackupObject): BackupObject {
  if (expected.locator !== file.id)
    throw invalidObject('database object mapping does not match the Drive file');
  // Preserve a self-consistent DB identity here. verifiedGoogleObject returns
  // Drive's actual size and checksum after inspecting the remote bytes.
  return { ...expected, locator: file.id };
}
function validatePortableIdentity(
  file: DriveFile,
  marker: ObjectMarker | null,
  rootId: string,
  expected?: BackupObject,
): ObjectMarker {
  if (!marker) throw invalidObject('backup marker is missing or malformed');
  validateMarkerRoot(marker, rootId);
  validateDriveChecksum(file, marker);
  validateExpectedPortableMapping(file, marker, expected);
  return marker;
}
function validateMarkerRoot(marker: ObjectMarker, rootId: string): void {
  if (marker.rootId !== rootId) throw invalidObject('backup marker belongs to a different root');
}
function validateDriveChecksum(file: DriveFile, marker: ObjectMarker): void {
  if (file.sha256Checksum && file.sha256Checksum !== marker.sha256)
    throw invalidObject('Google’s checksum does not match the backup marker');
}
function validateExpectedPortableMapping(
  file: DriveFile,
  marker: ObjectMarker,
  expected?: BackupObject,
): void {
  if (!expected) return;
  if (expected.locator !== file.id)
    throw invalidObject('database object mapping does not match the Drive file');
  if (marker.key !== expected.key || marker.sha256 !== expected.sha256)
    throw invalidObject('database object mapping does not match the backup marker');
}
function invalidObject(reason: string): Error {
  return new Error(`Google object failed identity or integrity validation: ${reason}.`);
}
export class ObjectIdentityError extends Error {}
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
    throw new ObjectIdentityError(message);
}
