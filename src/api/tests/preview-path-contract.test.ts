/**
 * Cross-platform preview path-derivation contract (#1997, epic #1993 stage 5).
 *
 * Server, web, and Apple each independently compute
 * `<relDir>/.maple/previews/<filename>.avif` for a given asset. This test
 * pins the SERVER half of that contract (`cachePathForAsset` — the
 * indexed/path-keyed resolver used by the `preview` stage and the
 * `/api/preview/:slug/*` route — and `cachePathFor`, the legacy/un-indexed
 * fallback used by `PUT /api/preview` and `/api/fs/preview`) against the
 * SAME golden fixture the web
 * (`src/web/projects/maple-common/src/lib/state/preview-path-contract.spec.ts`)
 * and Apple (`PreviewPathContractTests.swift`) resolvers are pinned against, so a
 * change to any one implementation's path scheme fails loudly here instead
 * of silently diverging from the other two. See
 * `tests/fixtures/preview-path-contract.json`'s header for the shared-fixture
 * convention (mirrors `auth-contract.json`).
 */

import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { cachePathFor, cachePathForAsset } from '../src/fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../src/indexer/previewer.ts';
import contract from './fixtures/preview-path-contract.json' with { type: 'json' };

const LIBRARY_ROOT = '/lib/photos';

describe('preview path contract — server resolvers agree with the shared golden (#1997)', () => {
  it('fixture is non-empty and every case has the fields this test depends on', () => {
    expect(contract.cases.length).toBeGreaterThan(0);
    for (const c of contract.cases) {
      expect(typeof c.relDir).toBe('string');
      expect(c.filename).toBeTruthy();
      expect(c.relPath).toBeTruthy();
    }
  });

  it.each(contract.cases.map((c) => [c.id, c.relDir, c.filename, c.relPath] as const))(
    'cachePathForAsset(%s) resolves <root>/%s',
    (_id, relDir, filename, relPath) => {
      const libraryId = new ObjectId();
      const asset = {
        maple_id: 'a'.repeat(32),
        fileinfo: [
          {
            library_id: libraryId,
            path: relDir,
            filename,
            deleted_at: null,
          },
        ],
      };
      const libs = new Map([[libraryId.toHexString(), LIBRARY_ROOT]]);

      const resolved = cachePathForAsset(asset as never, libs, 'previews', PREVIEW_CACHE_SUFFIX);

      expect(resolved).toBe(path.join(LIBRARY_ROOT, ...relPath.split('/')));
    },
  );

  it.each(contract.cases.map((c) => [c.id, c.relDir, c.filename, c.relPath] as const))(
    'cachePathFor (legacy, un-indexed) agrees with cachePathForAsset for %s',
    (_id, relDir, filename, relPath) => {
      // cachePathFor is keyed off a full asset abs path, not (relDir, filename)
      // separately — reconstruct the abs path the same way every un-indexed
      // caller (PUT /api/preview, /api/fs/preview's legacy() branch) does.
      const absPath = relDir
        ? path.join(LIBRARY_ROOT, ...relDir.split('/'), filename)
        : path.join(LIBRARY_ROOT, filename);

      const resolved = cachePathFor(absPath, 'previews', PREVIEW_CACHE_SUFFIX);

      expect(resolved).toBe(path.join(LIBRARY_ROOT, ...relPath.split('/')));
    },
  );
});
