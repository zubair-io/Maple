import type { BackupInspectOptions, BackupObject } from '../provider.ts';
import { assertDriveFileId, isDriveStatus, logicalKeyHash, type DriveFile } from './client.ts';
import type { GoogleDriveProvider } from './provider.ts';
import { verifiedGoogleObject } from './integrity.ts';
import { objectMarker, backupObject, assertObjectIdentity } from './object.ts';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// https://developers.google.com/workspace/drive/api/guides/search-files#escape
function driveQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function inspectGoogleObject(
  provider: GoogleDriveProvider,
  key: string,
  options: BackupInspectOptions,
  signal?: AbortSignal,
): Promise<BackupObject | null> {
  const match = options.locator
    ? await inspectLocator(provider, key, options.locator, signal, options.expected)
    : await inspectIndex(provider, key, signal);
  if (!match) return null;
  const heartbeat = options.heartbeat;
  const actual = await verifiedGoogleObject(
    provider,
    match,
    signal,
    heartbeat ? () => heartbeat(match) : undefined,
  );
  // Mirror paths are identified by their database mapping or their exact
  // path under the app-owned root. Their current bytes are authoritative for
  // reconciliation, so a checksum mismatch is returned to the mirror writer
  // to repair from the source instead of becoming a stuck validation error.
  if (!key.startsWith('mirror/'))
    assertObjectIdentity(
      actual,
      options.expected ?? match,
      'Google upload read-back checksum mismatch.',
    );
  return actual;
}

async function inspectLocator(
  provider: GoogleDriveProvider,
  key: string,
  locator: string,
  signal?: AbortSignal,
  expected?: BackupObject,
): Promise<BackupObject | null> {
  try {
    const file = await provider.client.metadata(locator, signal);
    const object = backupObject(file, provider.rootId, expected);
    if (object.key !== key) throw new Error('Backup object identity changed.');
    await provider.assertWithinRoot(file, signal);
    return object;
  } catch (error) {
    if (isDriveStatus(error, 404)) return null;
    throw error;
  }
}

function inspectIndex(
  provider: GoogleDriveProvider,
  key: string,
  signal?: AbortSignal,
): Promise<BackupObject | null> {
  return key.startsWith('mirror/')
    ? inspectMirrorIndex(provider, key, signal)
    : inspectPortableIndex(provider, key, signal);
}

async function inspectPortableIndex(
  provider: GoogleDriveProvider,
  key: string,
  signal?: AbortSignal,
): Promise<BackupObject | null> {
  const hash = logicalKeyHash(key);
  const target = await provider.findObjectTarget(key, signal);
  if (!target) return null;
  assertDriveFileId(target.parentId);
  // Bounded lookup: only files whose public hash property matches. Marker
  // metadata is verified after the match, never trusted from the index alone.
  // https://developers.google.com/workspace/drive/api/guides/search-files
  const query = `'${target.parentId}' in parents and trashed = false and properties has { key='mapleKeyHash' and value='${hash}' }`;
  const matches: BackupObject[] = [];
  for await (const file of provider.client.list(query, signal)) {
    const object = await inspectPortableCandidate(provider, file, key, hash, signal);
    if (!object) continue;
    matches.push(object);
    if (matches.length > 1)
      throw new Error('Conflicting immutable backup objects require operator review.');
  }
  return matches[0] ?? null;
}

async function inspectPortableCandidate(
  provider: GoogleDriveProvider,
  file: DriveFile,
  key: string,
  hash: string,
  signal?: AbortSignal,
): Promise<BackupObject | null> {
  const object = backupObject(file, provider.rootId);
  try {
    await provider.assertWithinRoot(file, signal);
  } catch {
    return null;
  }
  if (object.key !== key || file.properties?.['mapleKeyHash'] !== hash)
    throw new Error('Google backup search index does not match its portable object identity.');
  return object;
}

async function inspectMirrorIndex(
  provider: GoogleDriveProvider,
  key: string,
  signal?: AbortSignal,
): Promise<BackupObject | null> {
  const target = await provider.findObjectTarget(key, signal);
  if (!target) return null;
  const matches = await matchingFiles(provider, target, signal);
  if (matches.length > 1) throw new Error('Multiple Google files exist at the Maple mirror path.');
  const file = matches[0];
  if (!file) return null;
  await provider.assertWithinRoot(file, signal);
  // The exact path under Maple's managed root is enough to discover an
  // unmapped mirror candidate. Reconciliation hashes its bytes and rewrites
  // it from the source; marker metadata never establishes the DB mapping.
  return backupObject(file, provider.rootId, {
    key,
    locator: file.id,
    size: Number(file.size),
    sha256: objectMarker(file)?.sha256 ?? '0'.repeat(64),
  });
}

async function matchingFiles(
  provider: GoogleDriveProvider,
  target: { parentId: string; name: string },
  signal?: AbortSignal,
): Promise<DriveFile[]> {
  // Name-bounded so a mirror folder holding thousands of photos is never
  // enumerated per inspect; the in-memory filter guards against a lenient match.
  assertDriveFileId(target.parentId);
  const query = `'${target.parentId}' in parents and trashed = false and name = '${driveQueryString(target.name)}'`;
  const matches: DriveFile[] = [];
  for await (const file of provider.client.list(query, signal))
    if (file.name === target.name && file.mimeType !== FOLDER_MIME) matches.push(file);
  return matches;
}
