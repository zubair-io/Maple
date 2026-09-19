/**
 * GET /api/folder/:slug      — library-root listing (empty relPath)
 * GET /api/folder/:slug/*    — sub-folder listing
 *
 * Catalog-backed folder listing. Resolves the slug:relPath address to a
 * directory, reads the indexed assets from the catalog, and merges in any on-disk
 * files not yet in the catalog (listed as indexed:false). Enqueues a
 * discover scan for any unindexed entries.
 *
 * Response: FolderListing JSON + Server-Timing header.
 *
 * NB: Elysia's `*` wildcard does NOT match a bare `/folder/:slug` (no trailing
 * segment), so the library-root case needs its own route registration —
 * otherwise the root request falls through to the SPA static handler and
 * returns index.html (client sees "Http failure during parsing").
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { readdir } from 'node:fs/promises';
import { parseAddressPath, resolveAddress } from '../../library/address.ts';
import { listDirectoryAssets } from '../../db/repos/assets.address.ts';
import { child as childLogger } from '../../log.ts';
import {
  IMAGE_EXTENSIONS_SET,
  STUB_AND_AUDIO_EXTENSIONS_SET,
  parseWildcardSegments,
  wildcardSlugParams,
} from './shared.ts';
import { handleEvent } from '../../workers/discover/index.ts';
import { requireFileAccessBeforeHandle } from '../../auth/middleware.ts';

const log = childLogger('routes/library/folder');

const jsonError = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** One entry of a folder listing's `images` array. */
interface ListedImage {
  name: string;
  address: string;
  mapleId: string | null;
  indexed: boolean;
  width?: number;
  height?: number;
  capturedAt?: string;
}

/** What one `readdir` of the folder found, minus the cache directory. */
interface DiskEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * The address of a name inside this folder, or of the folder itself.
 *
 * Every address in a listing is built from the same two cases — a library root
 * has no path segment to join — and the function is here so the response
 * cannot end up with two spellings of the same address.
 */
function addressOf(slug: string, relPath: string, name?: string): string {
  const base = relPath === '' ? `${slug}:` : `${slug}:${relPath}`;
  if (name === undefined) return base;
  return relPath === '' ? `${slug}:${name}` : `${slug}:${relPath}/${name}`;
}

/** The parent folder's address, or null at a library root. */
function parentAddress(slug: string, relPath: string): string | null {
  if (relPath === '') return null;
  const parent = path.dirname(relPath);
  return parent === '.' ? `${slug}:` : `${slug}:${parent}`;
}

/**
 * What the folder holds on disk.
 *
 * A folder that cannot be read is not a failure of the listing: the catalog
 * half still answers, which is what a client browsing a library on a
 * disconnected volume sees. The reason is logged rather than returned.
 */
async function readDiskEntries(absPath: string): Promise<DiskEntry[]> {
  try {
    const dirents = await readdir(absPath, { withFileTypes: true });
    return dirents
      .filter((d) => d.name !== '.maple') // skip cache dir
      .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch (err) {
    log.warn(
      { absPath, err: err instanceof Error ? err.message : String(err) },
      'readdir failed on folder',
    );
    return [];
  }
}

/** Immediate subdirectories, hidden ones left out. */
function childFolders(
  slug: string,
  relPath: string,
  entries: readonly DiskEntry[],
): Array<{ name: string; address: string }> {
  return entries
    .filter((e) => e.isDirectory && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, address: addressOf(slug, relPath, e.name) }));
}

/** The images the catalog holds at this address. */
function catalogImages(
  slug: string,
  relPath: string,
  rows: Awaited<ReturnType<typeof listDirectoryAssets>>,
): ListedImage[] {
  return rows.map((row) => ({
    name: row.filename,
    address: addressOf(slug, relPath, row.filename),
    mapleId: row.maple_id,
    indexed: true,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    capturedAt: row.captured_at ?? undefined,
  }));
}

/**
 * On-disk image files the catalog does not have yet.
 *
 * Metadata-only stub images (eip/braw/afphoto/ai) and audio (#1835) get an
 * asset row too — see the `isMedia` check in `routes/folders.ts` — so they
 * belong in this listing the same way an unindexed photo does.
 */
function unindexedImages(
  slug: string,
  relPath: string,
  entries: readonly DiskEntry[],
  known: ReadonlySet<string>,
): ListedImage[] {
  return entries
    .filter((entry) => isUnindexedImage(entry, known))
    .map((entry) => ({
      name: entry.name,
      address: addressOf(slug, relPath, entry.name),
      mapleId: null,
      indexed: false,
    }));
}

function isUnindexedImage(entry: DiskEntry, known: ReadonlySet<string>): boolean {
  if (entry.isDirectory || known.has(entry.name)) return false;
  const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
  return IMAGE_EXTENSIONS_SET.has(ext) || STUB_AND_AUDIO_EXTENSIONS_SET.has(ext);
}

async function buildFolderListing(slug: string, wildcard: string): Promise<Response> {
  const t0 = performance.now();
  const segments = parseWildcardSegments(wildcard);
  const { relPath } = parseAddressPath(slug, segments);

  let resolved: Awaited<ReturnType<typeof resolveAddress>>;
  try {
    resolved = await resolveAddress(slug, relPath);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return jsonError(e.status ?? 500, e.message ?? 'Internal error');
  }

  const { libraryId, absPath } = resolved;

  // Query the catalog for images whose location is in THIS library AND at THIS
  // path. Library and directory are columns of one `asset_locations` row, so a
  // deduplicated asset can only surface the filename it holds here — the
  // cross-matching a loose dot-notation Mongo filter allowed (files from other
  // folders leaking into a listing) cannot be expressed.
  const catalogRows = await listDirectoryAssets(libraryId, relPath);
  const diskEntries = await readDiskEntries(absPath);

  const indexed = catalogImages(slug, relPath, catalogRows);
  const unindexed = unindexedImages(
    slug,
    relPath,
    diskEntries,
    new Set(catalogRows.map((row) => row.filename)),
  );

  // Something on disk is not in the catalog: ask discover to look at this
  // folder. Best-effort — the listing answers with what it already knows.
  if (unindexed.length > 0) {
    handleEvent({ kind: 'modified', absPath }, libraryId, resolved.libraryRoot).catch((err) => {
      log.warn(
        { absPath, err: err instanceof Error ? err.message : err },
        'discover enqueue failed',
      );
    });
  }

  const listing = {
    address: addressOf(slug, relPath),
    parent: parentAddress(slug, relPath),
    folders: childFolders(slug, relPath, diskEntries),
    images: [...indexed, ...unindexed],
  };
  return new Response(JSON.stringify(listing), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Server-Timing': `total;dur=${Math.round(performance.now() - t0)}`,
    },
  });
}

// Folder listings are filesystem browsing — file-access-gated (#2893). The
// sibling image/thumb/preview byte routes stay open: search/timeline hand
// out addresses, and reading pixels at a known address is not browsing.
export const folderRoutes = new Elysia()
  // Library root (empty relPath). Separate route because `*` won't match a
  // bare `/folder/:slug`.
  .get('/folder/:slug', ({ params }) => buildFolderListing(params.slug, ''), {
    beforeHandle: requireFileAccessBeforeHandle,
    params: t.Object({ slug: t.String({ minLength: 1 }) }),
  })
  .get(
    '/folder/:slug/*',
    ({ params }) => buildFolderListing(params.slug, (params as Record<string, string>)['*'] ?? ''),
    {
      beforeHandle: requireFileAccessBeforeHandle,
      params: wildcardSlugParams(),
    },
  );
