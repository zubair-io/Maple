import * as path from 'node:path';
import * as fs from '../fs/mirrored.ts';
import {
  listDirectoryAssets,
  listTrashedDirectoryFilenames,
  type DirectoryAsset,
} from '../db/repos/assets.address.ts';
import type { ResolvedAddress } from './address.ts';
import {
  canonicalBaseFromSidecarFilename,
  decodeCursor,
  encodeCursor,
  isUnderRoot,
} from '../fs/browse.ts';
import {
  RAW_EXTENSIONS,
  BITMAP_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
  isVideoFilename,
  isAudioFilename,
  isStubImageFilename,
} from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('library/folder-listing');
const IMAGE_EXTENSIONS = new Set([...RAW_EXTENSIONS, ...BITMAP_EXTENSIONS, ...PSD_HDR_EXTENSIONS]);

function addressOf(slug: string, relPath: string, name?: string): string {
  const relative = name === undefined ? relPath : relPath === '' ? name : `${relPath}/${name}`;
  return `${slug}:${relative}`;
}
function visibleName(name: string): boolean {
  return (
    !name.startsWith('.') &&
    !name.endsWith('.hidden') &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}
function isMedia(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  return (
    IMAGE_EXTENSIONS.has(ext) ||
    isVideoFilename(name) ||
    isAudioFilename(name) ||
    isStubImageFilename(name)
  );
}
function mediaFlags(name: string) {
  return {
    ...(isVideoFilename(name) ? { isVideo: true as const } : {}),
    ...(isAudioFilename(name) ? { isAudio: true as const } : {}),
    ...(isStubImageFilename(name) ? { isStub: true as const } : {}),
  };
}
async function diskNames(absPath: string): Promise<string[]> {
  try {
    return await fs.readdir(absPath);
  } catch (error) {
    log.warn({ absPath, error: String(error) }, 'directory unavailable; returning catalog entries');
    return [];
  }
}
interface Entry {
  name: string;
  address: string;
  path: string;
  mtime: string;
  size: number;
  ext: string;
  realPath?: string;
}
interface ImageEntry extends Entry {
  mapleId: string | null;
  indexed: boolean;
  id?: string;
  exif?: DirectoryAsset['exif'];
  width?: number;
  height?: number;
  capturedAt?: string;
  isVideo?: true;
  isAudio?: true;
  isStub?: true;
}
interface SidecarEntry extends Entry {
  asset_id: string;
}
interface Scanned {
  entry: Entry;
  stat: {
    size: number;
    mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
  } | null;
  catalog?: DirectoryAsset;
  realPath: string;
}

/** A request shares one resolved root and each child's checked realpath.
 * The image and its canonical/conflict XMPs must not redo that same I/O. */
function childResolver(directory: string, realRoot: string) {
  const paths = new Map<string, Promise<string | null>>();
  return (name: string): Promise<string | null> => {
    const cached = paths.get(name);
    if (cached) return cached;
    const pending = fs
      .realpath(path.join(directory, name))
      .then((real) => (isUnderRoot(real, realRoot) ? real : null))
      .catch(() => null);
    paths.set(name, pending);
    return pending;
  };
}

/** Only the selected page needs stat I/O. Every disk child is independently
 * realpathed against THIS library, never against the union of all libraries. */
async function scanEntry(
  name: string,
  slug: string,
  relPath: string,
  resolved: ResolvedAddress,
  state: FolderState,
): Promise<Scanned | null> {
  const onDisk = state.onDisk.has(name);
  const catalog = state.byName.get(name);
  const checked = onDisk ? await state.resolveChild(name) : null;
  if (onDisk && checked === null) return null;
  const real = checked ?? path.join(resolved.absPath, name);
  const stat = onDisk ? await fs.stat(real).catch(() => null) : null;
  if (onDisk && !stat) return null;
  if (!stat && !catalog) return null;
  if (stat && !stat.isFile() && !stat.isDirectory()) return null;
  return {
    entry: {
      name,
      address: addressOf(slug, relPath, name),
      // Realpath is the jail/stat target; clients navigate by the registered
      // library spelling, including in-library links and symlinked roots.
      path: path.join(resolved.absPath, name),
      size: stat?.size ?? catalog!.size,
      mtime: new Date(stat?.mtimeMs ?? catalog!.mtime).toISOString(),
      ext: stat?.isDirectory() ? '' : path.extname(name).slice(1).toLowerCase(),
    },
    stat,
    catalog,
    realPath: real,
  };
}
function imageEntry(scanned: Scanned): ImageEntry {
  const { entry, catalog } = scanned;
  return {
    ...entry,
    ...mediaFlags(entry.name),
    mapleId: catalog?.maple_id ?? null,
    indexed: catalog !== undefined,
    ...(catalog
      ? {
          id: catalog.id,
          exif: catalog.exif,
          width: catalog.width ?? undefined,
          height: catalog.height ?? undefined,
          capturedAt: catalog.captured_at ?? catalog.exif?.captured_at ?? undefined,
        }
      : {}),
  };
}

/** Sidecars pair across pages using the directory-indexed rows. An escaping
 * image link must not provide an identity to a sidecar in this directory. */
async function pairedAsset(
  name: string,
  byBase: ReadonlyMap<string, readonly DirectoryAsset[]>,
  names: ReadonlySet<string>,
  resolveChild: (name: string) => Promise<string | null>,
): Promise<string | null> {
  const base = canonicalBaseFromSidecarFilename(name);
  if (!base) return null;
  const candidates = byBase.get(base) ?? [];
  for (const row of candidates) {
    // Catalog-only entries keep their identity when their original is absent.
    if (!names.has(row.filename)) return row.id;
    if (await resolveChild(row.filename)) return row.id;
  }
  return null;
}

/** Build once per directory, rather than scanning its complete catalog for
 * each XMP on the requested page. A large folder stays O(rows + page). */
function sidecarCandidates(rows: readonly DirectoryAsset[]): Map<string, DirectoryAsset[]> {
  const byBase = new Map<string, DirectoryAsset[]>();
  for (const row of rows) {
    if (!visibleName(row.filename)) continue;
    const key = isVideoFilename(row.filename) ? row.filename : path.parse(row.filename).name;
    const candidates = byBase.get(key) ?? [];
    candidates.push(row);
    byBase.set(key, candidates);
  }
  return byBase;
}

async function directoryState(resolved: ResolvedAddress, relPath: string) {
  const [rows, trashed, names, realRoot] = await Promise.all([
    listDirectoryAssets(resolved.libraryId, relPath),
    listTrashedDirectoryFilenames(resolved.libraryId, relPath),
    diskNames(resolved.absPath),
    fs.realpath(resolved.libraryRoot).catch(() => resolved.libraryRoot),
  ]);
  const resolveChild = childResolver(resolved.absPath, realRoot);
  const hidden = new Set(trashed);
  const byName = new Map(rows.map((row) => [row.filename, row]));
  const byBase = sidecarCandidates(rows);
  const onDisk = new Set(names);
  const allNames = [...new Set([...names, ...rows.map((row) => row.filename)])]
    .filter((name) => visibleName(name) && !hidden.has(name))
    .sort();
  return { allNames, byName, byBase, onDisk, resolveChild };
}
type FolderState = Awaited<ReturnType<typeof directoryState>>;
interface FolderEntries {
  folders: Entry[];
  images: ImageEntry[];
  files: Entry[];
  sidecars: SidecarEntry[];
}

async function appendEntry(child: Scanned | null, entries: FolderEntries, state: FolderState) {
  if (!child) return;
  if (child.stat?.isDirectory()) {
    entries.folders.push({ ...child.entry, realPath: child.realPath });
    return;
  }
  if (isMedia(child.entry.name) || child.catalog) {
    entries.images.push(imageEntry(child));
    return;
  }
  if (child.entry.ext !== 'xmp') {
    entries.files.push(child.entry);
    return;
  }
  const assetId = await pairedAsset(
    child.entry.name,
    state.byBase,
    state.onDisk,
    state.resolveChild,
  );
  if (assetId) entries.sidecars.push({ ...child.entry, asset_id: assetId });
}

async function scanPage(
  slug: string,
  relPath: string,
  resolved: ResolvedAddress,
  page: readonly string[],
  state: FolderState,
): Promise<FolderEntries> {
  const entries: FolderEntries = { folders: [], images: [], files: [], sidecars: [] };
  // Bound filesystem fanout for both a page and the legacy complete listing.
  for (let start = 0; start < page.length; start += 32) {
    const scanned = await Promise.all(
      page.slice(start, start + 32).map((name) => scanEntry(name, slug, relPath, resolved, state)),
    );
    for (const child of scanned) await appendEntry(child, entries, state);
  }
  return entries;
}

export interface FolderPageOptions {
  cursor?: string;
  limit?: number;
}
/** Stable union ordering is independent of readdir order and host locale.
 * No pagination parameters preserves the historical complete listing. */
export async function listUnifiedFolder(
  slug: string,
  relPath: string,
  resolved: ResolvedAddress,
  options: FolderPageOptions,
) {
  const offset = options.cursor === undefined ? 0 : decodeCursor(options.cursor);
  const paged = options.cursor !== undefined || options.limit !== undefined;
  const limit = Math.max(1, Math.min(2000, options.limit ?? 500));
  const state = await directoryState(resolved, relPath);
  const page = paged ? state.allNames.slice(offset, offset + limit) : state.allNames;
  const entries = await scanPage(slug, relPath, resolved, page, state);
  const parentRel = path.posix.dirname(relPath);
  return {
    address: addressOf(slug, relPath),
    parent: relPath === '' ? null : addressOf(slug, parentRel === '.' ? '' : parentRel),
    path: resolved.absPath,
    // Recursive consumers use physical identity to stop in-library symlink cycles.
    realPath: await fs.realpath(resolved.absPath).catch(() => null),
    parentPath: relPath === '' ? null : path.dirname(resolved.absPath),
    ...entries,
    ...(paged && offset + limit < state.allNames.length
      ? { next_cursor: encodeCursor(offset + limit) }
      : {}),
  };
}
