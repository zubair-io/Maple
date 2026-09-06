import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_RECIPE,
  parseExportRecipe,
  exportRecipeProblem,
} from '../generated/export-recipe.generated';
import { recoverBrowserQueue, recipeSummary, type RecipeQueueRecord } from './export-recipe-store';

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
});
