import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_RECIPE,
  parseExportRecipe,
  exportRecipeProblem,
  exportCaptureTime,
} from '../generated/export-recipe.generated';
import { recoverBrowserQueue, recipeSummary, type RecipeQueueRecord } from './export-recipe-store';
import { runBrowserRecipe } from './browser-recipe-runner';

function interrupted(): RecipeQueueRecord {
  return {
    id: 'queue',
    recipe: { ...DEFAULT_EXPORT_RECIPE },
    serverJobId: null,
    cancelled: false,
    targets: [0, 1, 2, 3].map((index) => ({
      id: String(index),
      filename: `${index}.dng`,
      path: null,
      xmp: `<immutable-${index}/>`,
      filmLook: '',
      index,
      capturedAt: null,
    })),
    entries: [
      { id: '0', status: 'applied' },
      { id: '1', status: 'rendering' },
      { id: '2', status: 'delivering', filename: '2.jpg' },
      { id: '3', status: 'pending' },
    ],
  };
}
describe('export recipe contract and recovery', () => {
  it('preserves AVIF quality and existing automatic recipes', () => {
    for (const format of ['avif']) {
      for (const quality of [null, 55]) {
        const recipe = { ...DEFAULT_EXPORT_RECIPE, format, quality };
        expect(parseExportRecipe(recipe)).toEqual(recipe);
        expect(exportRecipeProblem(recipe)).toBeNull();
      }
      for (const quality of [0, 101]) {
        expect(exportRecipeProblem({ ...DEFAULT_EXPORT_RECIPE, format, quality })).toContain(
          'quality',
        );
      }
    }
  });
  it('preserves imported WebP quality and requires an explicit lossless correction', () => {
    const recipe = { ...DEFAULT_EXPORT_RECIPE, format: 'webp', quality: 55 };
    expect(parseExportRecipe(recipe)).toEqual(recipe);
    expect(exportRecipeProblem(recipe)).toContain('Lossless');
    expect(recipe.quality).toBe(55);
    expect(exportRecipeProblem({ ...recipe, quality: null })).toBeNull();
  });
  it('refuses a missing persisted directory instead of falling back to browser downloads', async () => {
    const record = interrupted();
    record.recipe = { ...record.recipe, destination: 'directory', directory: 'missing-folder' };
    const unexpected = async (): Promise<never> => {
      throw new Error('A missing destination must be rejected before rendering or delivery');
    };
    await expect(
      runBrowserRecipe(record, {
        filename: unexpected,
        render: unexpected,
        save: unexpected,
        cancelled: () => false,
        progress: () => {},
      }),
    ).rejects.toThrow('saved destination folder is unavailable');
  });
  it('normalizes capture metadata without applying the viewer timezone', () => {
    expect(exportCaptureTime('2026-07-02T23:58:59.123+12:00')).toBe('2026:07:02 23:58:59');
    expect(exportCaptureTime('2026-07-02T23:58:59Z')).toBe('2026:07:02 23:58:59');
    expect(exportCaptureTime('2026:07:02 23:58:59')).toBe('2026:07:02 23:58:59');
    expect(exportCaptureTime(null)).toBeNull();
    expect(exportCaptureTime('unknown')).toBe('unknown');
  });
  it('round-trips every field including explicit null values', () => {
    const recipe = {
      ...DEFAULT_EXPORT_RECIPE,
      format: 'tiff',
      quality: null,
      bitDepth: 16,
      maxLongEdge: 2048,
      outputProfile: 'display-p3',
      destination: 'directory',
      directory: '/exports',
      namingTemplate: '{date:%Y}_{original}_{n}.{ext}',
      overwritePolicy: 'skip',
    };
    expect(parseExportRecipe(JSON.parse(JSON.stringify(recipe)))).toEqual(recipe);
    expect(exportRecipeProblem(recipe)).toBeNull();
  });
  it('retains unsupported authored choices for storage but refuses execution', () => {
    const recipe = {
      ...DEFAULT_EXPORT_RECIPE,
      renderingIntent: 'relative-colorimetric',
      watermark: 'copyright',
    };
    expect(parseExportRecipe(recipe)).toEqual(recipe);
    expect(exportRecipeProblem(recipe)).toContain('rendering intent');
  });
  it('rejects missing, unknown and future-version fields instead of silently dropping them', () => {
    const { watermark: _watermark, ...missing } = DEFAULT_EXPORT_RECIPE;
    expect(() => parseExportRecipe(missing)).toThrow('missing or unknown');
    expect(() => parseExportRecipe({ ...DEFAULT_EXPORT_RECIPE, extra: 1 })).toThrow(
      'missing or unknown',
    );
    expect(() => parseExportRecipe({ ...DEFAULT_EXPORT_RECIPE, schemaVersion: 2 })).toThrow(
      'schemaVersion',
    );
    expect(() => parseExportRecipe({ ...DEFAULT_EXPORT_RECIPE, quality: 1.5 })).toThrow('quality');
  });
  it('retries interrupted rendering but requires explicit review of an uncertain browser download', () => {
    const before = interrupted();
    const recovered = recoverBrowserQueue(before);
    expect(recovered.entries.map((entry) => entry.status)).toEqual([
      'applied',
      'pending',
      'failed',
      'pending',
    ]);
    expect(recovered.entries[2].reason).toContain('Check your downloads');
    expect(recovered.targets).toEqual(before.targets);
    expect(before.entries[1].status).toBe('rendering');
    expect(recipeSummary(recovered)).toEqual({
      applied: ['0'],
      failed: [{ id: '2', reason: recovered.entries[2].reason }],
      cancelled: false,
    });
  });
  it('keeps the entire failure ledger while summaries render a bounded subset', () => {
    const record = interrupted();
    record.entries = Array.from({ length: 2000 }, (_, i) => ({
      id: String(i),
      status: 'failed',
      reason: 'Permission denied',
    }));
    expect(recipeSummary(record).failed).toHaveLength(2000);
  });
  it('refuses replacing an unselected sibling JPEG under {original}.{ext} + replace unless the export created it', async () => {
    const files = new Map<string, string>([
      ['IMG_1.CR3', 'raw-bytes'],
      ['IMG_1.JPG', 'camera-sibling-jpeg'],
    ]);
    const blobFor = (content: string): Blob => {
      const bytes = new TextEncoder().encode(content);
      return {
        size: bytes.byteLength,
        text: async () => content,
        stream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
      } as unknown as Blob;
    };
    const handleFor = (name: string): FileSystemFileHandle =>
      ({
        kind: 'file',
        name,
        isSameEntry: async (other: FileSystemHandle) => other.name === name,
        getFile: async () => blobFor(files.get(name) ?? '') as unknown as File,
        createWritable: async () => {
          let next = '';
          return {
            write: async (blob: Blob) => {
              next = await blob.text();
            },
            close: async () => {
              files.set(name, next);
            },
            abort: async () => {},
          } as unknown as FileSystemWritableFileStream;
        },
      }) as unknown as FileSystemFileHandle;
    const directoryHandle = {
      kind: 'directory',
      name: 'source',
      isSameEntry: async () => true,
      values: async function* () {
        for (const name of files.keys()) yield handleFor(name);
      },
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!files.has(name)) {
          if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
          files.set(name, '');
        }
        return handleFor(name);
      },
    } as unknown as FileSystemDirectoryHandle;
    const sourceHandle = handleFor('IMG_1.CR3');
    const record: RecipeQueueRecord = {
      id: 'sibling-guard',
      serverJobId: null,
      cancelled: false,
      directoryHandle,
      protectedOriginals: [sourceHandle],
      recipe: {
        ...DEFAULT_EXPORT_RECIPE,
        destination: 'directory',
        directory: 'source',
        namingTemplate: '{original}.{ext}',
        overwritePolicy: 'replace',
      },
      targets: [
        {
          id: 'raw-1',
          filename: 'IMG_1.CR3',
          sourceHandle,
          path: null,
          xmp: '',
          filmLook: '',
          capturedAt: null,
          index: 0,
        },
      ],
      entries: [{ id: 'raw-1', status: 'pending' }],
    };
    let renderCalls = 0;
    const run = (outputName: string, body: string) =>
      runBrowserRecipe(record, {
        filename: async () => outputName,
        render: async () => {
          renderCalls++;
          return { blob: blobFor(body), width: 1, height: 1, extension: 'jpg' };
        },
        save: async () => {},
        cancelled: () => false,
        progress: () => {},
      });
    await run('IMG_1.jpg', 'overwritten');
    expect(record.entries[0]).toEqual(
      expect.objectContaining({
        id: 'raw-1',
        status: 'failed',
        reason: expect.stringContaining('original photo'),
      }),
    );
    expect(renderCalls).toBe(0);
    expect(files.get('IMG_1.JPG')).toBe('camera-sibling-jpeg');

    record.entries = [{ id: 'raw-1', status: 'pending' }];
    await run('IMG_1_export.jpg', 'first-export');
    expect(record.entries[0].status).toBe('applied');
    expect(Object.keys(record.createdOutputs ?? {})).toEqual(['img_1_export.jpg']);
    expect(files.get('IMG_1_export.jpg')).toBe('first-export');

    record.entries = [{ id: 'raw-1', status: 'pending' }];
    await run('IMG_1_export.jpg', 'second-export');
    expect(record.entries[0].status).toBe('applied');
    expect(files.get('IMG_1_export.jpg')).toBe('second-export');

    files.set('IMG_1_export.jpg', 'user-moved-original-photo');
    record.entries = [{ id: 'raw-1', status: 'pending' }];
    await run('IMG_1_export.jpg', 'third-export');
    expect(record.entries[0]).toEqual(
      expect.objectContaining({
        id: 'raw-1',
        status: 'failed',
        reason: expect.stringContaining('original photo'),
      }),
    );
    expect(files.get('IMG_1_export.jpg')).toBe('user-moved-original-photo');
  });
});
