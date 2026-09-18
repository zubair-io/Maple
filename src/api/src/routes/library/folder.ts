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
import { listDirectoryAssets } from '../../db/sqlite/repos/assets.address.ts';
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

  // Address string helpers.
  const address = relPath === '' ? `${slug}:` : `${slug}:${relPath}`;
  const parent =
    relPath === ''
      ? null
      : (() => {
          const p = path.dirname(relPath);
          return p === '.' ? `${slug}:` : `${slug}:${p}`;
        })();

  // Query the catalog for images whose location is in THIS library AND at THIS
  // path. Library and directory are columns of one `asset_locations` row, so a
  // deduplicated asset can only surface the filename it holds here — the
  // cross-matching a loose dot-notation Mongo filter allowed (files from other
  // folders leaking into a listing) cannot be expressed.
  const catalogRows = await listDirectoryAssets(libraryId, relPath);

  // One readdir to find on-disk entries.
  let diskEntries: { name: string; isDirectory: boolean }[] = [];
  try {
    const dirents = await readdir(absPath, { withFileTypes: true });
    diskEntries = dirents
      .filter((d) => d.name !== '.maple') // skip cache dir
      .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ absPath, err: msg }, 'readdir failed on folder');
  }

  // Child folders — immediate subdirectories.
  const folders = diskEntries
    .filter((e) => e.isDirectory && !e.name.startsWith('.'))
    .map((e) => ({
      name: e.name,
      address: relPath === '' ? `${slug}:${e.name}` : `${slug}:${relPath}/${e.name}`,
    }));

  // Images — from the catalog, then on-disk files not yet indexed.
  const images: Array<{
    name: string;
    address: string;
    mapleId: string | null;
    indexed: boolean;
    width?: number;
    height?: number;
    capturedAt?: string;
  }> = [];
  const catalogFilenames = new Set<string>();

  for (const row of catalogRows) {
    catalogFilenames.add(row.filename);
    const fileAddress =
      relPath === '' ? `${slug}:${row.filename}` : `${slug}:${relPath}/${row.filename}`;
    images.push({
      name: row.filename,
      address: fileAddress,
      mapleId: row.maple_id,
      indexed: true,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      capturedAt: row.captured_at ?? undefined,
    });
  }

  // On-disk image files not in the catalog.
  let hasUnindexed = false;
  for (const entry of diskEntries) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
    // Metadata-only stub images (eip/braw/afphoto/ai) and audio (#1835) get
    // an AssetDoc too (see routes/folders.ts's isMedia check), so they
    // belong in this listing the same way unindexed images do.
    if (!IMAGE_EXTENSIONS_SET.has(ext) && !STUB_AND_AUDIO_EXTENSIONS_SET.has(ext)) continue;
    if (catalogFilenames.has(entry.name)) continue;
    const fileAddress =
      relPath === '' ? `${slug}:${entry.name}` : `${slug}:${relPath}/${entry.name}`;
    images.push({
      name: entry.name,
      address: fileAddress,
      mapleId: null,
      indexed: false,
    });
    hasUnindexed = true;
  }

  // Enqueue a discover scan if we found un-indexed files.
  if (hasUnindexed) {
    handleEvent({ kind: 'modified', absPath }, libraryId, resolved.libraryRoot).catch((err) => {
      log.warn(
        { absPath, err: err instanceof Error ? err.message : err },
        'discover enqueue failed',
      );
    });
  }

  const elapsed = Math.round(performance.now() - t0);
  const listing = { address, parent, folders, images };
  return new Response(JSON.stringify(listing), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Server-Timing': `total;dur=${elapsed}`,
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
