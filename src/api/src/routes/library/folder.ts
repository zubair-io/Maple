/**
 * GET /api/folder/:slug      — library-root listing (empty relPath)
 * GET /api/folder/:slug/*    — sub-folder listing
 *
 * Catalog-backed folder listing. Resolves the slug:relPath address to a
 * directory, reads the indexed assets from Mongo, and merges in any on-disk
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
import { assetsCollection } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';
import {
  IMAGE_EXTENSIONS_SET,
  STUB_AND_AUDIO_EXTENSIONS_SET,
  parseWildcardSegments,
} from './shared.ts';
import { handleEvent } from '../../workers/discover/index.ts';

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

  // Query the catalog for images whose fileinfo has an entry in THIS library
  // AND at THIS path (same entry — $elemMatch). A loose dot-notation match
  // (`{'fileinfo.library_id': id, 'fileinfo.path': relPath}`) would
  // cross-match deduplicated assets whose library_id and path live in
  // DIFFERENT fileinfo entries, leaking files from other folders/libraries.
  const coll = await assetsCollection();
  const catalogRows = await coll
    .find(
      {
        fileinfo: {
          $elemMatch: {
            library_id: libraryId,
            path: relPath,
            deleted_at: null,
            missing_since: null,
          },
        },
        deleted_at: null,
      },
      {
        projection: {
          maple_id: 1,
          'fileinfo.filename': 1,
          'fileinfo.path': 1,
          'fileinfo.library_id': 1,
          'exif.captured_at': 1,
          'exif.width': 1,
          'exif.height': 1,
        },
      },
    )
    .toArray();

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
    // Match the fileinfo entry on BOTH library_id and path so a deduplicated
    // asset surfaces its filename for THIS folder only.
    const fi = (
      row.fileinfo as Array<{
        filename: string;
        path: string;
        library_id: unknown;
      }>
    ).find((f) => String(f.library_id) === libraryId.toHexString() && f.path === relPath);
    if (!fi) continue;
    catalogFilenames.add(fi.filename);
    const exif = row.exif as { captured_at?: string; width?: number; height?: number } | undefined;
    const fileAddress =
      relPath === '' ? `${slug}:${fi.filename}` : `${slug}:${relPath}/${fi.filename}`;
    images.push({
      name: fi.filename,
      address: fileAddress,
      mapleId: (row.maple_id as string | null) ?? null,
      indexed: true,
      width: exif?.width ?? undefined,
      height: exif?.height ?? undefined,
      capturedAt: exif?.captured_at ?? undefined,
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

export const folderRoutes = new Elysia()
  // Library root (empty relPath). Separate route because `*` won't match a
  // bare `/folder/:slug`.
  .get('/folder/:slug', ({ params }) => buildFolderListing(params.slug, ''), {
    params: t.Object({ slug: t.String({ minLength: 1 }) }),
  })
  .get(
    '/folder/:slug/*',
    ({ params }) => buildFolderListing(params.slug, (params as Record<string, string>)['*'] ?? ''),
    {
      params: t.Object({
        slug: t.String({ minLength: 1 }),
        '*': t.Optional(t.String()),
      }),
    },
  );
