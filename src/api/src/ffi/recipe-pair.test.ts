/**
 * The paired recipe render (#6034) at each hop: the native binding against the
 * single-recipe binding as its oracle, the child's dispatch arm, and the pool
 * request that carries it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { copyFile, mkdtemp, readFile, realpath, rm, stat } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { _createFfiPoolForTests, type PoolWorker } from './ffi-pool.ts';
import { handleFfiRequest } from './raw_ffi-dispatch.ts';
import type { ExportRecipePairRequest } from './raw_ffi-protocol.ts';
import { nativeLibAvailable, tryGetRawFfi, type RawFfi } from './raw_ffi.ts';
import type { RecipePairOutcome } from './recipe-pair-ffi.ts';

const syntheticRaw = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../test-fixtures/batch-transfer/source.dng',
);
const editedXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="-2" crs:Highlights2012="-65"/></rdf:RDF></x:xmpmeta>`;
const recipe = (maxLongEdge: number) =>
  JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, quality: 90, maxLongEdge });

describe.skipIf(!nativeLibAvailable())('maple_export_recipe_pair_to_files binding', () => {
  let directory: string;
  let rawPath: string;
  const ffi = () => tryGetRawFfi() as RawFfi;
  const out = (name: string) => join(directory, name);

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-recipe-pair-')));
    rawPath = out('photo.dng');
    await copyFile(syntheticRaw, rawPath);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes the bytes of two single-recipe renders', async () => {
    expect(ffi().exportRecipeToFile?.(rawPath, editedXmp, recipe(24), null, out('a'))).toBeNull();
    expect(ffi().exportRecipeToFile?.(rawPath, editedXmp, recipe(48), null, out('b'))).toBeNull();
    expect(
      ffi().exportRecipePairToFiles?.(
        rawPath,
        editedXmp,
        null,
        { recipeJson: recipe(24), outPath: out('pair-a') },
        { recipeJson: recipe(48), outPath: out('pair-b') },
      ),
    ).toEqual({ written: 'both' });
    const [a, b] = [await readFile(out('a')), await readFile(out('b'))];
    expect((await readFile(out('pair-a'))).equals(a)).toBe(true);
    expect((await readFile(out('pair-b'))).equals(b)).toBe(true);
    expect(a.equals(b)).toBe(false);
  });

  it('reports a second render that failed without losing the first', async () => {
    expect(ffi().exportRecipeToFile?.(rawPath, editedXmp, recipe(24), null, out('a'))).toBeNull();
    expect(
      ffi().exportRecipePairToFiles?.(
        rawPath,
        editedXmp,
        null,
        { recipeJson: recipe(24), outPath: out('pair-a') },
        { recipeJson: recipe(48), outPath: join(directory, 'absent', 'pair-b') },
      ),
    ).toEqual({ written: 'first' });
    expect((await readFile(out('pair-a'))).equals(await readFile(out('a')))).toBe(true);
  });

  it('reports a failed first render as an error and writes nothing', async () => {
    const outcome = ffi().exportRecipePairToFiles?.(
      out('absent.dng'),
      editedXmp,
      null,
      { recipeJson: recipe(24), outPath: out('pair-a') },
      { recipeJson: recipe(48), outPath: out('pair-b') },
    );
    expect(outcome).toEqual({ error: expect.stringContaining('original read') });
    await expect(stat(out('pair-a'))).rejects.toThrow();
    await expect(stat(out('pair-b'))).rejects.toThrow();
  });
});

describe.skipIf(!nativeLibAvailable())('exportRecipePair dispatch arm', () => {
  const request: ExportRecipePairRequest = {
    type: 'exportRecipePair',
    id: 12,
    rawPath: '/photos/a.dng',
    xmp: '',
    filmPath: null,
    first: { recipeJson: '{"first":true}', outPath: '/tmp/a.jpg' },
    second: { recipeJson: '{"second":true}', outPath: '/tmp/b.jpg' },
  };
  const binding = (outcome: RecipePairOutcome, seen: unknown[][] = []) =>
    ({
      exportRecipePairToFiles: (...args: unknown[]) => {
        seen.push(args);
        return outcome;
      },
    }) as unknown as RawFfi;

  it('passes the request through and reports which files were written', async () => {
    const seen: unknown[][] = [];
    expect(await handleFfiRequest(binding({ written: 'both' }, seen), request)).toEqual({
      type: 'exportRecipePair',
      id: 12,
      ok: true,
      second: true,
    });
    expect(seen).toEqual([['/photos/a.dng', '', null, request.first, request.second]]);
    expect(await handleFfiRequest(binding({ written: 'first' }), request)).toEqual({
      type: 'exportRecipePair',
      id: 12,
      ok: true,
      second: false,
    });
  });

  it('answers a failed first render, or a dylib without the entry, with an error', async () => {
    expect(await handleFfiRequest(binding({ error: 'original read: gone' }), request)).toEqual({
      type: 'exportRecipePair',
      id: 12,
      ok: false,
      error: 'original read: gone',
    });
    expect(await handleFfiRequest({} as RawFfi, request)).toEqual({
      type: 'exportRecipePair',
      id: 12,
      ok: false,
      error: 'Rebuild raw-ffi: paired recipe render unavailable',
    });
  });
});

describe('FfiWorkerPool — exportRecipePair', () => {
  class FakeWorker implements PoolWorker {
    posted: Array<Record<string, unknown>> = [];
    private reply: ((e: { data: unknown }) => void) | null = null;
    postMessage(message: unknown): void {
      this.posted.push(message as Record<string, unknown>);
    }
    terminate(): void {}
    addEventListener(type: 'message' | 'error', callback: (e: never) => void): void {
      if (type === 'message') this.reply = callback as (e: { data: unknown }) => void;
    }
    respond(body: Record<string, unknown>): void {
      this.reply?.({ data: { ...body, id: this.posted.at(-1)?.id } });
    }
  }

  function dispatch() {
    const workers: FakeWorker[] = [];
    const pool = _createFfiPoolForTests({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = { recipeJson: 'a', outPath: '/a.jpg' };
    const second = { recipeJson: 'b', outPath: '/b.jpg' };
    const result = pool.exportRecipePairToFiles('/raw.dng', '<x/>', '/luts', first, second);
    return { result, worker: () => workers[0]!, first, second };
  }

  it('posts one RAW-lane request carrying both staging files', () => {
    const { result, worker, first, second } = dispatch();
    void result.catch(() => undefined);
    expect(worker().posted).toEqual([
      {
        type: 'exportRecipePair',
        id: expect.any(Number),
        rawPath: '/raw.dng',
        xmp: '<x/>',
        filmPath: '/luts',
        first,
        second,
      },
    ]);
  });

  it('resolves with whether the second file was written', async () => {
    const both = dispatch();
    both.worker().respond({ type: 'exportRecipePair', ok: true, second: true });
    expect(await both.result).toEqual({ second: true });
    const firstOnly = dispatch();
    firstOnly.worker().respond({ type: 'exportRecipePair', ok: true, second: false });
    expect(await firstOnly.result).toEqual({ second: false });
  });

  it('rejects when the first render failed', async () => {
    const failed = dispatch();
    failed.worker().respond({ type: 'exportRecipePair', ok: false, error: 'original read: gone' });
    await expect(failed.result).rejects.toThrow('original read: gone');
  });
});
