import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ExportRecipeRenderService } from './export-recipe-render.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { provideHostedWorkspace } from '../workspace/hosted-workspace.providers';
import { provideRouter } from '@angular/router';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated';

const emptyPhotoXmp =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description/></rdf:RDF></x:xmpmeta>';
describe('browser recipe quality transport (#4197)', () => {
  for (const format of ['avif'])
    for (const quality of [null, 55])
      it(`${format} ${quality ?? 'automatic'} follows shared recipe options`, async () => {
        const exportImage = vi.fn(async (..._args: unknown[]) => ({ blob: new Blob() }));
        TestBed.configureTestingModule({
          providers: [
            provideHttpClient(),
            provideHostedWorkspace(),
            provideRouter([]),
            { provide: RawPipelineService, useValue: { exportImage } },
          ],
        });
        const source = new File([new Uint8Array([1, 2, 3])], 'owned.jpg');
        await TestBed.inject(ExportRecipeRenderService).render(
          {
            id: 'owned',
            filename: source.name,
            path: null,
            xmp: emptyPhotoXmp,
            filmLook: '',
            capturedAt: null,
            index: 0,
            sourceHandle: { getFile: async () => source } as FileSystemFileHandle,
          },
          { ...DEFAULT_EXPORT_RECIPE, format, quality },
        );
        expect(exportImage.mock.calls[0][2]).toEqual({
          format,
          quality: quality ?? DEFAULT_EXPORT_RECIPE.quality,
          colorSpace: 'srgb',
          maxSidePixels: undefined,
        });
        expect(new Uint8Array(await source.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      });
});

it('rejects imported numeric WebP quality before reading or rendering the source', async () => {
  const exportImage = vi.fn();
  const getFile = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHostedWorkspace(),
      provideRouter([]),
      { provide: RawPipelineService, useValue: { exportImage } },
    ],
  });
  const recipe = { ...DEFAULT_EXPORT_RECIPE, format: 'webp', quality: 55 };
  await expect(
    TestBed.inject(ExportRecipeRenderService).render(
      {
        id: 'owned',
        filename: 'owned.jpg',
        path: null,
        xmp: emptyPhotoXmp,
        filmLook: '',
        capturedAt: null,
        index: 0,
        sourceHandle: { getFile } as unknown as FileSystemFileHandle,
      },
      recipe,
    ),
  ).rejects.toThrow('Lossless');
  expect(getFile).not.toHaveBeenCalled();
  expect(exportImage).not.toHaveBeenCalled();
  expect(recipe.quality).toBe(55);
});
