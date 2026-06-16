/**
 * GET /api/folder/:slug/*
 *
 * Catalog-backed folder listing. Resolves the slug:relPath address to a
 * directory, reads the indexed assets from Mongo, and merges in any on-disk
 * files not yet in the catalog (listed as indexed:false). Enqueues a
 * discover scan for any unindexed entries.
 *
 * Response: FolderListing JSON + Server-Timing header.
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { readdir } from 'node:fs/promises';
import { parseAddressPath, resolveAddress } from '../../library/address.ts';
import { assetsCollection } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';
import { IMAGE_EXTENSIONS_SET } from './shared.ts';
import { handleEvent } from '../../workers/discover/index.ts';

const log = childLogger('routes/library/folder');

const IMMUTABLE = 'public, max-age=31536000, immutable';

export const folderRoutes = new Elysia()
  .get(
    '/folder/:slug/*',
    async ({ params, set }) => {
      const t0 = performance.now();
      const slug = params.slug;
      const wildcard = (params as Record<string, string>)['*'] ?? '';
      const segments = wildcard ? wildcard.split('/') : [];
      const { relPath } = parseAddressPath(slug, segments);

      let resolved: Awaited<ReturnType<typeof resolveAddress>>;
      try {
        resolved = await resolveAddress(slug, relPath);
      } catch (err) {
        const e = err as { status?: number; message?: string };
        set.status = e.status ?? 500;
        return { error: e.message ?? 'Internal error' };
      }

      const { libraryId, absPath } = resolved;

      // Address string helpers
      const address = relPath === '' ? `${slug}:` : `${slug}:${relPath}`;
      const parent =
        relPath === ''
          ? null
          : (() => {
              const p = path.dirname(relPath);
              return p === '.' ? `${slug}:` : `${slug}:${p}`;
            })();

      // Query the catalog for images at this path.
      const coll = await assetsCollection();
      const catalogRows = await coll
        .find(
          { 'fileinfo.library_id': libraryId, 'fileinfo.path': relPath, deleted_at: null },
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

      // Build a set of catalogued filenames for fast disk-vs-catalog diff.
      const catalogFilenames = new Set<string>();
      const imagesByCatalog = new Map<
        string,
        { maple_id: string | null; exif?: Record<string, unknown> }
      >();
      for (const row of catalogRows) {
        const fi = (row.fileinfo as Array<{ filename: string; library_id: unknown }>).find(
          (f) => String(f.library_id) === libraryId.toHexString(),
        );
        if (!fi) continue;
        catalogFilenames.add(fi.filename);
        imagesByCatalog.set(fi.filename, {
          maple_id: (row.maple_id as string | null) ?? null,
          exif: row.exif as Record<string, unknown> | undefined,
        });
      }

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

      // Images — from catalog + on-disk files not yet indexed.
      const images: Array<{
        name: string;
        address: string;
        mapleId: string | null;
        indexed: boolean;
        width?: number;
        height?: number;
        capturedAt?: string;
      }> = [];

      let hasUnindexed = false;

      for (const row of catalogRows) {
        const fi = (row.fileinfo as Array<{ filename: string; library_id: unknown }>).find(
          (f) => String(f.library_id) === libraryId.toHexString(),
        );
        if (!fi) continue;
        const exif = row.exif as
          | { captured_at?: string; width?: number; height?: number }
          | undefined;
        const fileAddress = relPath === '' ? `${slug}:${fi.filename}` : `${slug}:${relPath}/${fi.filename}`;
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
      for (const entry of diskEntries) {
        if (entry.isDirectory) continue;
        const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
        if (!IMAGE_EXTENSIONS_SET.has(ext)) continue;
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
        handleEvent({ kind: 'modified', absPath }, libraryId, resolved.libraryRoot).catch(
          (err) => {
            log.warn({ absPath, err: err instanceof Error ? err.message : err }, 'discover enqueue failed');
          },
        );
      }

      const elapsed = Math.round(performance.now() - t0);
      const listing = { address, parent, folders, images };
      const body = JSON.stringify(listing);

      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Server-Timing': `db;dur=${elapsed}`,
        },
      });
    },
    {
      params: t.Object({
        slug: t.String({ minLength: 1 }),
        '*': t.Optional(t.String()),
      }),
    },
  );
