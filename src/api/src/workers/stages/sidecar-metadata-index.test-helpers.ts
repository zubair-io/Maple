/**
 * Shared fixtures for the `sidecar-metadata-index` stage's two suites.
 *
 * The stage is tested against a real temp directory and real sidecar files —
 * XMP is the contract, so nothing here mocks it — and against no database at
 * all on the handler's own path. Both suites need the same four things: a
 * library root the library cache resolves, a sidecar written into it, an
 * `ImageDoc` pointing at it, and a way to read the handler's result.
 *
 * ## Reading a run back
 *
 * Since the SQLite cutover (#3787) the handler returns the statements the
 * runner will commit rather than a map of document fields, so an assertion
 * about "what this run writes" has to get at the values behind those
 * statements. {@link written} zips the column statement's assignment list back
 * together with its bound parameters and decodes the override document from its
 * JSON parameter, which is enough for every case that is about the projection
 * itself. The cases that are about the database — the `is_screenshot`
 * tri-state, and a `hidden_reason` the sidecar says nothing about — run the
 * statements for real instead; see `sidecar-metadata-index.projection.test.ts`.
 */

import { afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ObjectId } from '../../db/object-id.ts';
import type { Logger } from 'pino';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import type { ImageDoc } from '../run-stage.ts';
import type { StageContext } from '../stage-config.ts';
import type { sidecarMetadataIndexHandler } from './sidecar-metadata-index.ts';

export const FAKE_LIB_ID = 'aabbccddeeff001122334455';

export const fakeCtx: StageContext = {
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => fakeCtx.log,
  } as unknown as Logger,
  signal: new AbortController().signal,
};

export type HandlerResult = Awaited<ReturnType<typeof sidecarMetadataIndexHandler>>;

/** One run's writes, as the values behind the statements it returned. */
export interface Written {
  /** The `assets` columns the run set, keyed by column name. */
  columns: Record<string, unknown>;
  /** The `metadata_override` document, decoded from its JSON parameter. */
  override: Record<string, unknown>;
}

const COLUMN_PREFIX = 'UPDATE assets SET ';

/**
 * Read a successful run back as the values it would write. Throws on a skip, so
 * a test that expected a patch fails with the reason rather than an undefined
 * read.
 */
export function written(result: HandlerResult): Written {
  if (!('patch' in result)) throw new Error(`Expected patch result, got ${JSON.stringify(result)}`);
  const columns: Record<string, unknown> = {};
  let override: Record<string, unknown> = {};
  for (const statement of result.patch) {
    const params = [...((statement.params ?? []) as unknown[])];
    if (!statement.sql.startsWith(COLUMN_PREFIX)) {
      override = JSON.parse(String(params[0])) as Record<string, unknown>;
      continue;
    }
    const assignments = statement.sql.slice(COLUMN_PREFIX.length, statement.sql.indexOf(' WHERE'));
    for (const assignment of assignments.split(', ')) {
      columns[assignment.replace(' = ?', '')] = params.shift();
    }
  }
  return { columns, override };
}

/** The stages a successful run asked the runner to re-arm. */
export function invalidatesOf(result: HandlerResult): string[] {
  if (!('patch' in result)) throw new Error('Expected patch result');
  return [...(result.invalidates ?? [])];
}

export function makeImage(overrides: Partial<ImageDoc> = {}): ImageDoc {
  return {
    _id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
    fileinfo: [
      {
        path: '',
        filename: 'test.dng',
        library_id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
      },
    ],
    size: 1000,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    stages: {
      'sidecar-metadata-index': {
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
    },
    ...overrides,
  };
}

export function makeXmp(attrs: string, nested = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:exif="http://ns.adobe.com/exif/1.0/"
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
   xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:papp="https://justmaple.app/ns/1.0/"
   ${attrs}>
${nested}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

/** A temp library root, minted per test and wired into the library cache. */
export interface TempLibrary {
  /** The root directory. Rebound before each test, so read it inside one. */
  dir: string;
}

/**
 * Install the per-test temp-library lifecycle and hand back a handle to it.
 *
 * A mutable handle rather than a returned path because the directory is minted
 * in `beforeEach`, after the suite body has already run.
 */
export function useTempLibrary(): TempLibrary {
  const library: TempLibrary = { dir: '' };
  beforeEach(async () => {
    library.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-metadata-index-test-'));
    setLibraryRootsForTests(new Map([[FAKE_LIB_ID, library.dir]]));
  });
  afterEach(async () => {
    setLibraryRootsForTests(null); // reset to lazy-load
    await fs.rm(library.dir, { recursive: true, force: true });
  });
  return library;
}

/** Write `test.dng` + its stem-swapped `test.xmp`, and point an ImageDoc at it. */
export async function writeSidecar(library: TempLibrary, xmpContent: string): Promise<ImageDoc> {
  await fs.writeFile(path.join(library.dir, 'test.dng'), '');
  await fs.writeFile(path.join(library.dir, 'test.xmp'), xmpContent, 'utf-8');
  return makeImage();
}

/**
 * Write a video file + its full-name sidecar (`clip.mov.xmp`) and return an
 * ImageDoc pointing at the video. Videos use the full-name convention so a Live
 * Photo's motion clip never clobbers the same-stem still's `.xmp`.
 */
export async function writeVideoSidecar(
  library: TempLibrary,
  xmpContent: string,
): Promise<ImageDoc> {
  await fs.writeFile(path.join(library.dir, 'clip.mov'), '');
  await fs.writeFile(path.join(library.dir, 'clip.mov.xmp'), xmpContent, 'utf-8');
  return makeImage({
    fileinfo: [
      {
        path: '',
        filename: 'clip.mov',
        library_id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
      },
    ],
  });
}
