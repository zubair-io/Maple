// Name-only imported Auto WB (#4669) through the REAL worker round trip: the
// production RawPipelineService, worker handlers and wasm bundle, joined by the
// in-process channel in `raw-pipeline.in-process-worker.test-helpers.ts`.
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CpuLiveSession, render_bytes_sized } from './pkg/raw_wasm';
import { RawPipelineService } from './raw-pipeline.service';
import type { DecodedImage } from './raw-pipeline.types';
import {
  fixtureRaw,
  installInProcessRawWorker,
} from './raw-pipeline.in-process-worker.test-helpers';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import {
  hydratePartialWhiteBalance,
  renderModelForImportedAuto,
  withResolvedImportedAuto,
} from '../models/partial-white-balance';
import {
  importedAutoBackgroundEstimate,
  resolveImportedAutoAfterFirstFrame,
} from '../components/image-canvas/image-canvas.imported-auto-wb';
import { EditPreviewPersistService } from '../state/edit-preview-persist.service';
import { HostedRawSidecarService } from '../state/hosted-raw-sidecar.service';
import { LibraryStore } from '../state/library-store.service';
import { LibraryCache } from '../state/library-cache.service';
import type { LibraryStateService } from '../state/library-state.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import { FilmLutService } from '../film/film-lut.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { HostedSidecarFreshnessService } from '../xmp/hosted-sidecar-freshness.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { PRIMARY_VARIANT_ID } from '../generated/workflow.generated';

type Pair = { temperature: number; tint: number };
const nameOnly =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>';
const parser = new XmpParserService();
const serializer = new XmpSerializerService();

/** What the store holds once the first frame seeded As Shot: intent, unresolved. */
function openedModel(asShot: Pair): AdjustmentModel {
  const parsed = { ...defaultAdjustmentModel(), ...parser.parseAdjustmentModel(nameOnly).model };
  return hydratePartialWhiteBalance(parsed, asShot.temperature, asShot.tint, true);
}
/** The core's one-shot develop, which resolves a name-only Auto itself. */
function oneShot(bytes: Uint8Array, xmp: string, edge: number, preview: boolean): number[] {
  const image = render_bytes_sized(bytes, 'dng', xmp, preview, edge);
  try {
    return [...image.take_rgb()];
  } finally {
    image.free();
  }
}
/** The shared estimator's pair for `bytes`, from an independent session. */
function estimate(bytes: Uint8Array): Pair {
  const session = CpuLiveSession.open(bytes, 'dng');
  try {
    const [temperature, tint] = session.resolve_imported_white_balance();
    return { temperature, tint };
  } finally {
    session.free();
  }
}
const asShotXmp = nameOnly.replace('"Auto"', '"As Shot"');

describe('imported name-only Auto WB through the real render worker (#4669)', () => {
  let restore: () => void;
  let pipeline: RawPipelineService;
  // Production signatures as of #4669; typed loosely so this spec also compiles
  // against the pre-fix signatures it was written to fail.
  let resolveWb: (bytes: Uint8Array) => Promise<Pair>;
  const afterFirstFrame = resolveImportedAutoAfterFirstFrame as unknown as (
    state: LibraryStateService,
    pipeline: RawPipelineService,
    id: string,
    bytes: Uint8Array,
  ) => void;

  beforeAll(async () => {
    restore = (await installInProcessRawWorker()).restore;
  });
  afterAll(() => restore());

  let model: AdjustmentModel;
  const writePreview = vi.fn(() => of(undefined));
  beforeEach(() => {
    importedAutoBackgroundEstimate.enabled = true;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStore,
          useValue: {
            findAsset: () => ({ filename: 'a.dng' }),
            adjustmentFor: () => () => model,
            backend: 'self-hosted',
            absPathFor: () => '/lib/a.dng',
            currentFolder: () => null,
            workflowVariants: { variantFor: () => PRIMARY_VARIANT_ID },
          },
        },
        { provide: LibraryCache, useValue: { bytesFor: () => editorBytes } },
        { provide: MapleCacheService, useValue: {} },
        { provide: SERVER_WORKSPACE_PERSISTENCE, useValue: { writePreview } },
        { provide: XmpStoreService, useValue: {} },
        { provide: HostedSidecarFreshnessService, useValue: {} },
        { provide: FolderAccessService, useValue: {} },
        { provide: FilmLutService, useValue: { getLattice: async () => null } },
      ],
    });
    pipeline = TestBed.inject(RawPipelineService);
    resolveWb = (bytes) =>
      (pipeline.resolveImportedWhiteBalance as (bytes: Uint8Array) => Promise<Pair>).call(
        pipeline,
        bytes,
      );
  });
  afterEach(() => {
    importedAutoBackgroundEstimate.enabled = false;
  });
  let editorBytes = fixtureRaw('source');

  /** The editor's 2D first frame: a sized decode that retains the CPU source. */
  async function firstFrame(bytes: Uint8Array): Promise<DecodedImage> {
    return pipeline.decode(bytes, 'dng', nameOnly, 640, true);
  }
  async function persistedPixels(): Promise<number[]> {
    const decode = vi.spyOn(pipeline, 'decode');
    const persist = TestBed.inject(EditPreviewPersistService);
    persist.schedule('a');
    persist.flushAll();
    await persist.whenIdle();
    expect(decode).toHaveBeenCalledTimes(1);
    return [...((await decode.mock.results[0].value) as DecodedImage).rgb];
  }

  it('persists the preview with the estimate, not As Shot, before the pair lands', async () => {
    editorBytes = fixtureRaw('source');
    const opened = await firstFrame(editorBytes);
    model = openedModel({ temperature: opened.asShotTemperature, tint: opened.asShotTint });
    const pixels = await persistedPixels();
    const xmp = serializer.serialize(model);
    expect(xmp).not.toMatch(/crs:Temperature=/);
    expect(pixels).not.toEqual(oneShot(editorBytes, asShotXmp, 1280, false));
    expect(pixels).toEqual(oneShot(editorBytes, xmp, 1280, false));
  });

  it('persists the preview with the landed pair as numbers on the retained source', async () => {
    editorBytes = fixtureRaw('source');
    const opened = await firstFrame(editorBytes);
    const pair = await resolveWb(editorBytes);
    expect(pair).toEqual(estimate(editorBytes));
    model = withResolvedImportedAuto(
      openedModel({ temperature: opened.asShotTemperature, tint: opened.asShotTint }),
      pair,
    );
    const pixels = await persistedPixels();
    expect(pixels).not.toEqual(oneShot(editorBytes, asShotXmp, 1280, false));
    // The same numbers the canvas renders, so the cached preview matches the editor.
    const rendered = serializer.serialize(renderModelForImportedAuto(model));
    expect(rendered).toMatch(/crs:Temperature=/);
    expect(pixels).toEqual(oneShot(editorBytes, rendered, 1280, false));
  });

  it('develops hosted sidecar thumbnails with the estimate, not As Shot', async () => {
    const bytes = fixtureRaw('target');
    await firstFrame(fixtureRaw('source'));
    const decode = vi.spyOn(pipeline, 'decode');
    await TestBed.inject(HostedRawSidecarService)
      .develop(bytes, 'dng', nameOnly)
      .catch(() => undefined); // jsdom has no image encoder; the pixels are the contract
    const image = (await decode.mock.results[0].value) as DecodedImage;
    expect([...image.rgb]).not.toEqual(oneShot(bytes, asShotXmp, 1280, true));
    expect([...image.rgb]).toEqual(oneShot(bytes, nameOnly, 1280, true));
  });

  it("never hands photo A another photo's pair after a sized decode replaced A's source", async () => {
    const a = fixtureRaw('source');
    const x = fixtureRaw('target');
    const pairA = estimate(a);
    const pairX = estimate(x);
    expect(pairA).not.toEqual(pairX);
    const opened = await firstFrame(a);
    // A sized decode of another photo (a hosted thumbnail, a persisted preview)
    // lands between A's first frame and its resolve request.
    await pipeline.decode(x, 'dng', nameOnly, 1280, true);
    const resolve = vi.fn();
    const state = {
      adjustmentFor: () => () =>
        openedModel({ temperature: opened.asShotTemperature, tint: opened.asShotTint }),
      resolveImportedAutoWhiteBalance: resolve,
    } as unknown as LibraryStateService;
    const request = vi.spyOn(pipeline, 'resolveImportedWhiteBalance');
    afterFirstFrame(state, pipeline, 'a', a);
    await Promise.allSettled(request.mock.results.map((result) => result.value));
    await new Promise((settled) => setTimeout(settled, 0));
    expect(resolve).not.toHaveBeenCalledWith('a', pairX);
    expect(resolve).not.toHaveBeenCalled();
    await expect(resolveWb(a)).rejects.toThrow();

    // A's own session resolves A's pair.
    await firstFrame(a);
    afterFirstFrame(state, pipeline, 'a', a);
    await Promise.allSettled(request.mock.results.map((result) => result.value));
    await new Promise((settled) => setTimeout(settled, 0));
    expect(resolve).toHaveBeenCalledWith('a', pairA);
  });

  it('resolves on the 2D fallback after a failed GPU open of the same photo', async () => {
    const bytes = fixtureRaw('source');
    // No WebGPU here: the worker refuses the live session, as a gpu-off runtime does.
    await expect(
      pipeline.openLiveSession({} as OffscreenCanvas, bytes, 'dng', nameOnly, 640),
    ).rejects.toThrow();
    await expect(resolveWb(bytes)).rejects.toThrow();
    await firstFrame(bytes);
    await expect(resolveWb(bytes)).resolves.toEqual(estimate(bytes));
  });
});
