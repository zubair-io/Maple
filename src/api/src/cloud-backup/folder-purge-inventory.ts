import * as path from 'node:path';
import { realpath } from '../fs/mirrored.ts';
import { listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import { jailedFile, fileHash, relativeBackupPath } from './inventory.ts';
import type { BackupRepository, BackupDestination, BackupEntry } from './repository.ts';

interface RecordedLocation {
  ordinal: number;
  primary_ordinal: number;
  library_id: string;
  root: string;
  relative_path: string;
  missing_since: string | null;
  deleted_reason: string | null;
  apple_rendered_path: string | null;
}
interface LocalFile {
  path: string;
  sha256: string | null;
}
interface RetainedManifest {
  localFiles?: LocalFile[];
  files?: Array<{ path: string; role: string; object: { sha256: string } }>;
}
const RETRY =
  'Mirror purge identity unavailable. Reconnect the source/mirror or manually verify and remove the retained mirror copy before retrying permanent deletion.';

function retained(entry: BackupEntry): RetainedManifest {
  return entry.manifest ? (JSON.parse(entry.manifest) as RetainedManifest) : {};
}
function knownHashes(entries: BackupEntry[], relative: string, original: string): Set<string> {
  const hashes = entries.flatMap((entry) => {
    const manifest = retained(entry);
    return [
      ...(manifest.localFiles ?? [])
        .filter((file) => file.path === relative)
        .map((file) => file.sha256),
      ...(manifest.files ?? [])
        .filter(
          (file) => file.path === relative || (relative === original && file.role === 'original'),
        )
        .map((file) => file.object.sha256),
    ];
  });
  return new Set(
    hashes.filter(
      (hash): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
    ),
  );
}
async function hashIfPresent(root: string, relative: string): Promise<string | null> {
  try {
    return await fileHash(await jailedFile(root, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function pairedPaths(root: string, relative: string): Promise<string[]> {
  try {
    return (await listPairedSidecarsStrict(path.join(root, relative))).map((file) =>
      relativeBackupPath(path.relative(root, file).split(path.sep).join('/')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function overlaps(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
async function mirrorRoot(
  destination: BackupDestination,
  location: RecordedLocation,
): Promise<string | null> {
  if (!destination.path) throw new Error(RETRY);
  const root = await realpath(destination.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const source = await realpath(location.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return path.resolve(location.root);
    throw error;
  });
  if (root && (overlaps(root, source) || overlaps(source, root)))
    throw new Error(
      'Mirror purge root overlaps the original library; reconnect a separate mirror before retry.',
    );
  return root;
}

async function verifiedLocalFile(
  relative: string,
  location: RecordedLocation,
  mirror: string | null,
  history: BackupEntry[],
): Promise<LocalFile> {
  relativeBackupPath(relative);
  const sourceHash = await hashIfPresent(location.root, relative);
  const known = knownHashes(history, relative, location.relative_path);
  if (sourceHash) known.add(sourceHash);
  if (mirror) {
    const current = await hashIfPresent(mirror, relative);
    if (current && known.has(current)) return { path: relative, sha256: current };
    if (current && (location.deleted_reason === 'reaped' || location.missing_since || !known.size))
      throw new Error(RETRY);
  }
  // An absent target needs no deletion, but retain known identity to reject a
  // later unrelated occupant. Offline ordinary Trash requires a source/hash.
  if (!mirror && !known.size) throw new Error(RETRY);
  return { path: relative, sha256: sourceHash ?? [...known][0] ?? null };
}

async function inventoryLocation(
  assetId: string,
  destination: BackupDestination,
  location: RecordedLocation,
  history: BackupEntry[],
  repo: BackupRepository,
): Promise<void> {
  relativeBackupPath(location.relative_path);
  const mirror = await mirrorRoot(destination, location);
  if (!mirror && (location.deleted_reason === 'reaped' || location.missing_since))
    throw new Error(RETRY);
  const entry = await repo.ensureEntry(
    destination.id,
    assetId,
    location.ordinal,
    location.relative_path,
  );
  const previous = retained(entry).localFiles ?? [];
  // apple_rendered_path belongs to the primary location's library root; a
  // deduplicated copy in another library must not erase that root's namesake.
  const companions =
    location.ordinal === location.primary_ordinal && location.apple_rendered_path
      ? [relativeBackupPath(location.apple_rendered_path)]
      : [];
  const paths = [
    ...new Set([
      location.relative_path,
      ...companions,
      ...previous.map((file) => file.path),
      ...(await pairedPaths(location.root, location.relative_path)),
      ...(mirror ? await pairedPaths(mirror, location.relative_path) : []),
    ]),
  ];
  const localFiles: LocalFile[] = [];
  for (const relative of paths)
    localFiles.push(await verifiedLocalFile(relative, location, mirror, history));
  await repo.db.write('UPDATE backup_entries SET manifest=? WHERE id=?', [
    JSON.stringify({ localFiles }),
    entry.id,
  ]);
}

/** Erasure follows recorded paths, including missing/reaped locations, rather
 * than the live-source admission rules used by outbound backup uploads. */
export async function inventoryFolderPurges(
  assetId: string,
  repo: BackupRepository,
): Promise<void> {
  const locations = await repo.db.read<RecordedLocation>(
    `SELECT l.ordinal,(SELECT MIN(ordinal) FROM asset_locations WHERE asset_id=l.asset_id) AS primary_ordinal,
      l.library_id,f.path AS root,
      CASE WHEN l.path='' THEN l.filename ELSE l.path||'/'||l.filename END AS relative_path,
      l.missing_since,a.deleted_reason,a.apple_rendered_path
      FROM asset_locations l JOIN folders f ON f.id=l.library_id JOIN assets a ON a.id=l.asset_id
      WHERE l.asset_id=?`,
    [assetId],
  );
  const history = await repo.db.read<BackupEntry>('SELECT * FROM backup_entries WHERE asset_id=?', [
    assetId,
  ]);
  for (const destination of (await repo.destinations()).filter((item) => item.kind === 'folder')) {
    for (const location of locations.filter((item) => item.library_id === destination.libraryId)) {
      await inventoryLocation(assetId, destination, location, history, repo);
    }
  }
}
