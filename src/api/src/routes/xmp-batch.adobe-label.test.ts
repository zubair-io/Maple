/** Real-file POST /api/xmp/batch coverage for the authored `xmp:Label` rule (#4470 / #4403). */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from '../fs/mirrored.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import { Elysia } from 'elysia';
import { xmpBatchRoutes } from './xmp-batch.ts';
import { parseXmpMetadata } from '../xmp/metadata-parser.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { registerLibrary } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

const app = new Elysia().use(xmpBatchRoutes);
const TEST_SLUG = 'xmp-batch-adobe-label-test';

let live: LiveTestDatabase;
let tmpDir: string;
let originalMapleRoots: string | undefined;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xmp-batch-label-')));
  originalMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = tmpDir;
  registerLibrary(live.db, tmpDir, TEST_SLUG);
});

afterEach(async () => {
  if (originalMapleRoots !== undefined) process.env.MAPLE_ROOTS = originalMapleRoots;
  else delete process.env.MAPLE_ROOTS;
  invalidateLibraryRoots();
  live.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const sidecarWith = (descriptionAttrs: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Exposure2012="0.75"
   ${descriptionAttrs}>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

async function editSidecar(
  authoredXml: string,
  metadata: Record<string, unknown>,
): Promise<{ status: number; xml: string }> {
  await fs.writeFile(path.join(tmpDir, 'photo.dng'), '');
  await fs.writeFile(path.join(tmpDir, 'photo.xmp'), authoredXml);
  const res = await app.handle(
    new Request('http://localhost/api/xmp/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ address: `${TEST_SLUG}:photo.dng`, metadata }] }),
    }),
  );
  return { status: res.status, xml: await fs.readFile(path.join(tmpDir, 'photo.xmp'), 'utf-8') };
}

describe('POST /api/xmp/batch — authored xmp:Label (#4470)', () => {
  test('a contradicting Adobe colour word is dropped when the colour label changes', async () => {
    const { status, xml } = await editSidecar(sidecarWith('xmp:Label="Red"'), {
      colorLabel: 'blue',
    });
    expect(status).toBe(200);
    expect(xml).not.toContain('xmp:Label');
    expect(xml).toContain('papp:ColorLabel="blue"');
    expect(parseXmpMetadata(xml).colorLabel).toBe('blue');
  });

  test('a non-colour label word survives a colour-label change', async () => {
    const { status, xml } = await editSidecar(sidecarWith('xmp:Label="To Do"'), {
      colorLabel: 'green',
    });
    expect(status).toBe(200);
    expect(xml).toContain('xmp:Label="To Do"');
    expect(parseXmpMetadata(xml).colorLabel).toBe('green');
  });

  test('an unrelated edit leaves the authored label and rating bytes untouched', async () => {
    const authoredAttrs = 'xmp:Rating="-1"\n   xmp:Label="Red"';
    const { status, xml } = await editSidecar(sidecarWith(authoredAttrs), { city: 'Rome' });
    expect(status).toBe(200);
    expect(xml).toContain(authoredAttrs);
    expect(parseXmpMetadata(xml)).toMatchObject({ city: 'Rome', colorLabel: 'red' });
  });

  test('clearing the colour label drops an Adobe colour word', async () => {
    const { status, xml } = await editSidecar(
      sidecarWith('xmp:Label="Purple"\n   xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
      { colorLabel: null },
    );
    expect(status).toBe(200);
    expect(xml).not.toContain('xmp:Label');
    expect(parseXmpMetadata(xml).colorLabel).toBeUndefined();
  });

  test('clearing the colour label keeps a non-colour label word', async () => {
    const { status, xml } = await editSidecar(sidecarWith('xmp:Label="To Do"'), {
      colorLabel: null,
    });
    expect(status).toBe(200);
    expect(xml).toContain('xmp:Label="To Do"');
  });

  test('re-setting the colour the authored word already names keeps it', async () => {
    const { status, xml } = await editSidecar(sidecarWith('xmp:Label="Red"'), {
      colorLabel: 'red',
    });
    expect(status).toBe(200);
    expect(xml).toContain('xmp:Label="Red"');
    expect(xml).toContain('papp:ColorLabel="red"');
  });
});
