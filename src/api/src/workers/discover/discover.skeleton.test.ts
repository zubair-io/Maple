/**
 * Discover producer — stage-skeleton tests.
 *
 * Verifies that a newly discovered file gets one `stage_state` row per stage in
 * `ALL_STAGE_NAMES`, all at version 0.
 *
 * The skeleton used to be a `stages` subdocument written into the asset itself;
 * it is a dense set of rows in `stage_state` now, seeded in the same
 * transaction as the asset and its location. Dense rather than lazy is
 * load-bearing: a missing row would make the claim an anti-join against
 * `assets`, which cannot use an index at all.
 */
import { describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ALL_STAGE_NAMES } from '../stages/manifest.ts';
import { assetIdAt, createDiscoverLibrary, stageRow } from './discover.test-helpers.ts';
import { handleEvent } from './index.ts';

describe('discover producer — skeleton', () => {
  it('inserts a row with the full stage skeleton when a file is created', async () => {
    using library = await createDiscoverLibrary('discover-test-');

    const file = path.join(library.root, 'test.jpg');
    await writeFile(file, Buffer.alloc(100, 0xcc));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    const assetId = assetIdAt(library.db, '', 'test.jpg');
    expect(assetId).not.toBeNull();

    for (const name of ALL_STAGE_NAMES) {
      const entry = stageRow(library.db, assetId!, name);
      expect(entry).not.toBeNull();
      expect(entry!.version).toBe(0);
      expect(entry!.dead).toBe(0);
      expect(entry!.last_error).toBeNull();
    }
  });
});
