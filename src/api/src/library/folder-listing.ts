import * as path from 'node:path';
import * as fs from '../fs/mirrored.ts';
import {
  listDirectoryAssets,
  listTrashedDirectoryFilenames,
  type DirectoryAsset,
} from '../db/repos/assets.address.ts';
import type { ResolvedAddress } from './address.ts';
import { canonicalBaseFromSidecarFilename, decodeCursor, encodeCursor } from '../fs/browse.ts';
import {
  RAW_EXTENSIONS,
  BITMAP_EXTENSIONS,
  PSD_HDR_EXTENSIONS,
  isVideoFilename,
  VIDEO_EXTS,
  AUDIO_EXTS,
  STUB_IMAGE_EXTS,
} from '../indexer/media-types.ts';
import { directoryHasIgnoreMarker } from '../fs/mapleignore.ts';
import { child as childLogger } from '../log.ts';
import { xmpSidecarPath } from '../fs/xmp-sidecar-path.ts';
import { authorizeSidecarRead, readSidecarNoFollow } from '../fs/sidecar-io.ts';
import { readFileWithFailover } from '../fs/mirror-read.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { parseFolderCulling, type FolderCulling } from './folder-culling.ts';
import { readFolderCulling } from './folder-culling-cache.ts';
import {
  childInspector,
  sharedGrant,
  type ChildFacts,
  type ChildInspector,
  type ChildStat,
} from './folder-child.ts';
import { freshThumbVersion, listingThumbStat, thumbsDirectorySafe } from './thumb-version.ts';
import { pairLivePhotos, type LivePhotoLink } from './live-photo-pairs.ts';
import { pairRawJpegStacks } from './raw-jpeg-stack.ts';

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
interface MediaClass {
  isMedia: boolean;
  flags: { isVideo?: true; isAudio?: true; isStub?: true };
}
/** One lookup per set from the already-lowercased extension, rather than four `extname` calls. */
function classifyMedia(extension: string): MediaClass {
  const dotted = `.${extension}`;
  const isVideo = VIDEO_EXTS.has(dotted);
  const isAudio = AUDIO_EXTS.has(dotted);
  const isStub = STUB_IMAGE_EXTS.has(dotted);
  return {
    isMedia: IMAGE_EXTENSIONS.has(extension) || isVideo || isAudio || isStub,
    flags: {
      ...(isVideo ? { isVideo: true as const } : {}),
      ...(isAudio ? { isAudio: true as const } : {}),
      ...(isStub ? { isStub: true as const } : {}),
    },
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
  isMotionPhoto?: true;
  livePhoto?: LivePhotoLink;
  stack?: { companion: StackCompanion };
  edited?: boolean;
  rating?: number;
  flag?: 'pick' | 'reject';
  colorLabel?: string;
  /** Present only while the on-disk thumb is fresh; `?v=` it to cache the thumb as immutable. */
  thumbVersion?: string;
}
/** The JPEG folded into its RAW's tile: the second file the Info pane lists. */
interface StackCompanion extends Entry {
  id?: string;
}
interface SidecarEntry extends Entry {
  asset_id: string;
}
interface Scanned {
  entry: Entry;
  stat: ChildStat | null;
  catalog?: DirectoryAsset;
  realPath: string;
  media: MediaClass;
}

/** A file or folder on disk, or a catalog row whose original is absent. */
function isListable(stat: ChildStat | null, catalog: DirectoryAsset | undefined): boolean {
  return stat ? stat.isFile() || stat.isDirectory() : catalog !== undefined;
}

function listedEntry(
  name: string,
  address: string,
  absPath: string,
  stat: ChildStat | null,
  catalog: DirectoryAsset | undefined,
  extension: string,
): Entry {
  return {
    name,
    address,
    // Realpath is the jail/stat target; clients navigate by the registered
    // library spelling, including in-library links and symlinked roots.
    path: path.join(absPath, name),
    size: stat?.size ?? catalog!.size,
    mtime: new Date(stat?.mtimeMs ?? catalog!.mtime).toISOString(),
    ext: stat?.isDirectory() ? '' : extension,
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
  const facts = onDisk ? await state.inspectChild(name) : null;
  if (onDisk && facts === null) return null;
  const stat = facts?.stat ?? null;
  if (!isListable(stat, catalog)) return null;
  const extension = path.extname(name).slice(1).toLowerCase();
  return {
    entry: listedEntry(
      name,
      addressOf(slug, relPath, name),
      resolved.absPath,
      stat,
      catalog,
      extension,
    ),
    stat,
    catalog,
    realPath: facts?.real ?? path.join(resolved.absPath, name),
    media: classifyMedia(extension),
  };
}
function imageEntry(scanned: Scanned, livePairs: ReadonlyMap<string, LivePhotoLink>): ImageEntry {
  const { entry, catalog } = scanned;
  const livePhoto = catalog ? livePairs.get(entry.name) : undefined;
  return {
    ...entry,
    ...(livePhoto ? { livePhoto } : {}),
    ...scanned.media.flags,
    mapleId: catalog?.maple_id ?? null,
    indexed: catalog !== undefined,
    ...(catalog
      ? {
          id: catalog.id,
          exif: catalog.exif,
          width: catalog.width ?? undefined,
          height: catalog.height ?? undefined,
          capturedAt: catalog.captured_at ?? catalog.exif?.captured_at ?? undefined,
          ...(catalog.motion_photo ? { isMotionPhoto: true as const } : {}),
        }
      : {}),
  };
}

function stackCompanion({ entry, catalog }: Scanned): StackCompanion {
  return { ...entry, ...(catalog ? { id: catalog.id } : {}) };
}

/** Sidecars pair across pages using the directory-indexed rows. An escaping
 * image link must not provide an identity to a sidecar in this directory. */
async function pairedAsset(
  name: string,
  byBase: ReadonlyMap<string, readonly DirectoryAsset[]>,
  names: ReadonlySet<string>,
  inspectChild: ChildInspector,
): Promise<string | null> {
  const base = canonicalBaseFromSidecarFilename(name);
  if (!base) return null;
  const candidates = byBase.get(base) ?? [];
  for (const row of candidates) {
    // Catalog-only entries keep their identity when their original is absent.
    if (!names.has(row.filename)) return row.id;
    if (await inspectChild(row.filename)) return row.id;
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

async function directoryState(resolved: ResolvedAddress, relPath: string, stack: boolean) {
  const [rows, trashed, names, realRoot, realDirectory, thumbsSafe] = await Promise.all([
    listDirectoryAssets(resolved.libraryId, relPath),
    listTrashedDirectoryFilenames(resolved.libraryId, relPath),
    diskNames(resolved.absPath),
    fs.realpath(resolved.libraryRoot).catch(() => resolved.libraryRoot),
    fs.realpath(resolved.absPath).catch(() => null),
    thumbsDirectorySafe(resolved.absPath),
  ]);
  const inspectChild = childInspector(resolved.absPath, realDirectory, realRoot);
  const authorizeDirectSidecars = sharedGrant(
    async (sidecar: string) => (await authorizedSidecar(sidecar)) !== null,
  );
  const hidden = new Set(trashed);
  const byName = new Map(rows.map((row) => [row.filename, row]));
  const byBase = sidecarCandidates(rows);
  const livePairs = pairLivePhotos(rows.filter((row) => !hidden.has(row.filename)));
  const onDisk = new Set(names);
  const visibleNames = [...new Set([...names, ...rows.map((row) => row.filename)])]
    .filter((name) => visibleName(name) && !hidden.has(name))
    .sort();
  const stackCompanionOf = stack ? pairRawJpegStacks(visibleNames) : new Map<string, string>();
  const companions = new Set(stackCompanionOf.values());
  const allNames = visibleNames.filter((name) => !companions.has(name));
  return {
    allNames,
    byName,
    byBase,
    livePairs,
    onDisk,
    inspectChild,
    authorizeDirectSidecars,
    realDirectory,
    stackCompanionOf,
    thumbsSafe,
  };
}
type FolderState = Awaited<ReturnType<typeof directoryState>>;
interface FolderEntries {
  folders: Entry[];
  images: ImageEntry[];
  files: Entry[];
  sidecars: SidecarEntry[];
}

type ImageCulling = Partial<Pick<ImageEntry, 'edited' | 'rating' | 'flag' | 'colorLabel'>>;
/** `sidecarMtimeMs` is 0 with no sidecar and null when one exists but could not be read. */
interface SidecarState {
  culling: ImageCulling;
  sidecarMtimeMs: number | null;
}
const UNREADABLE_SIDECAR: SidecarState = { culling: {}, sidecarMtimeMs: null };
type ImageFields = ImageCulling & Pick<ImageEntry, 'thumbVersion'>;

function cullingFields(parsed: FolderCulling): ImageCulling {
  return {
    edited: true,
    ...(parsed.rating !== undefined ? { rating: parsed.rating } : {}),
    ...(parsed.flag !== undefined ? { flag: parsed.flag } : {}),
    ...(parsed.colorLabel !== undefined ? { colorLabel: parsed.colorLabel } : {}),
  };
}

/** A mirror failover read has no handle stat, so its mtime is unknown. */
async function readAuthorizedCulling(sidecar: string, listed?: ChildStat): Promise<SidecarState> {
  const { culling, mtimeMs } = await readFolderCulling(sidecar, listed).catch(async () => ({
    culling: parseFolderCulling(await readFileWithFailover(sidecar, readSidecarNoFollow)),
    mtimeMs: null,
  }));
  return { culling: cullingFields(culling), sidecarMtimeMs: mtimeMs };
}

async function authorizedSidecar(sidecar: string): Promise<string | null> {
  const allowed = await authorizeSidecarRead(sidecar);
  return allowed.ok && allowed.data ? allowed.data : null;
}

/** A sidecar that is a plain file of this directory resolves to the directory's real path plus
 * its name, so one authorization of the directory's first such sidecar answers for all of them.
 * Anything else (a symlinked sidecar) is authorized on its own. */
async function authorizedCulling(
  sidecar: string,
  facts: ChildFacts,
  state: FolderState,
): Promise<SidecarState> {
  if (!facts.direct || !facts.stat.isFile()) {
    const allowed = await authorizedSidecar(sidecar);
    return allowed === null ? UNREADABLE_SIDECAR : readAuthorizedCulling(allowed);
  }
  return (await state.authorizeDirectSidecars(sidecar))
    ? readAuthorizedCulling(facts.real, facts.stat)
    : UNREADABLE_SIDECAR;
}

/** Read the canonical sidecar during the folder walk. The catalog can lag behind
 * a newly registered directory, and filters must work before Preview hydrates
 * each photo individually. Avoid I/O for the common sidecar-free case. */
async function imageCulling(child: Scanned, state: FolderState): Promise<SidecarState> {
  const sidecar = xmpSidecarPath(child.entry.path);
  try {
    const name = path.basename(sidecar);
    if (!state.onDisk.has(name)) return { culling: {}, sidecarMtimeMs: 0 };
    const facts = await state.inspectChild(name);
    if (!facts || path.extname(facts.real).toLowerCase() !== '.xmp') return UNREADABLE_SIDECAR;
    return await authorizedCulling(sidecar, facts, state);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT' && errnoCode(error) !== 'ELOOP') {
      log.warn(
        { sidecar, error: String(error) },
        'could not read sidecar culling for folder listing',
      );
    }
    return UNREADABLE_SIDECAR;
  }
}

/** The thumb route renders beside the primary location only, so another location's thumb
 * would version bytes the route never serves for this address. */
function thumbServedHere(child: Scanned, state: FolderState): boolean {
  const servedHere = !child.catalog?.maple_id || child.catalog.primary_here;
  return state.thumbsSafe && servedHere && child.stat?.isFile() === true;
}

async function imageSidecarFields(child: Scanned, state: FolderState): Promise<ImageFields> {
  const [{ culling, sidecarMtimeMs }, thumb] = await Promise.all([
    imageCulling(child, state),
    thumbServedHere(child, state) ? listingThumbStat(child.entry.path) : null,
  ]);
  const version =
    sidecarMtimeMs === null
      ? null
      : freshThumbVersion(thumb, child.stat?.mtimeMs ?? 0, sidecarMtimeMs);
  return { ...culling, ...(version ? { thumbVersion: version } : {}) };
}

async function appendEntry(
  child: Scanned,
  entries: FolderEntries,
  state: FolderState,
  culling: ImageFields,
  companion: Scanned | null,
) {
  if (child.stat?.isDirectory()) {
    if (await directoryHasIgnoreMarker(child.realPath)) return;
    entries.folders.push({ ...child.entry, realPath: child.realPath });
    return;
  }
  if (child.media.isMedia || child.catalog) {
    entries.images.push({
      ...imageEntry(child, state.livePairs),
      ...(companion ? { stack: { companion: stackCompanion(companion) } } : {}),
      ...culling,
    });
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
    state.inspectChild,
  );
  if (assetId) entries.sidecars.push({ ...child.entry, asset_id: assetId });
}

interface PageUnit {
  child: Scanned;
  companion: Scanned | null;
}
const isStackHalf = (scanned: Scanned | null): scanned is Scanned =>
  scanned !== null && !scanned.stat?.isDirectory();

/** A stack lists only when both halves are files. Otherwise each half that scans lists on its
 * own: a RAW the listing cannot show, or a directory named like a JPEG, never hides its partner. */
async function scanUnits(
  name: string,
  slug: string,
  relPath: string,
  resolved: ResolvedAddress,
  state: FolderState,
): Promise<PageUnit[]> {
  const companionName = state.stackCompanionOf.get(name);
  const [child, companion] = await Promise.all([
    scanEntry(name, slug, relPath, resolved, state),
    companionName ? scanEntry(companionName, slug, relPath, resolved, state) : null,
  ]);
  if (isStackHalf(child) && isStackHalf(companion)) return [{ child, companion }];
  return [child, companion].flatMap((scanned) =>
    scanned ? [{ child: scanned, companion: null }] : [],
  );
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
    const units = (
      await Promise.all(
        page
          .slice(start, start + 32)
          .map((name) => scanUnits(name, slug, relPath, resolved, state)),
      )
    ).flat();
    const sidecars = await Promise.all(
      units.map(({ child }) =>
        child.media.isMedia || child.catalog
          ? imageSidecarFields(child, state)
          : Promise.resolve({}),
      ),
    );
    for (const [index, unit] of units.entries()) {
      await appendEntry(unit.child, entries, state, sidecars[index] ?? {}, unit.companion);
    }
  }
  return entries;
}

/** Children were read under the real path resolved when the request began. A folder renamed or
 * relinked meanwhile could have answered for another place, so that listing is not returned. */
async function requireSameDirectory(directory: string, realAtStart: string | null): Promise<void> {
  const realNow = await fs.realpath(directory).catch(() => null);
  if (realNow === realAtStart) return;
  throw Object.assign(new Error('Folder changed while it was being listed; retry.'), {
    status: 409,
  });
}

export interface FolderPageOptions {
  cursor?: string;
  limit?: number;
  /** Fold same-stem RAW+JPEG pairs (#5050); only stack-aware clients ask, with `stack=1`. */
  stack?: boolean;
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
  const state = await directoryState(resolved, relPath, options.stack === true);
  const page = paged ? state.allNames.slice(offset, offset + limit) : state.allNames;
  const entries = await scanPage(slug, relPath, resolved, page, state);
  await requireSameDirectory(resolved.absPath, state.realDirectory);
  const parentRel = path.posix.dirname(relPath);
  return {
    address: addressOf(slug, relPath),
    parent: relPath === '' ? null : addressOf(slug, parentRel === '.' ? '' : parentRel),
    path: resolved.absPath,
    // Recursive consumers use physical identity to stop in-library symlink cycles.
    realPath: state.realDirectory,
    parentPath: relPath === '' ? null : path.dirname(resolved.absPath),
    ...entries,
    ...(paged && offset + limit < state.allNames.length
      ? { next_cursor: encodeCursor(offset + limit) }
      : {}),
  };
}
