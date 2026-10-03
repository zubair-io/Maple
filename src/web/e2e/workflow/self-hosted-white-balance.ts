import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideSelfHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/self-hosted-workspace.providers';
import type { ApiFolder } from '../../projects/maple-common/src/lib/workspace/server-library-io';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { XmpAdjustmentRestoreService } from '../../projects/maple-common/src/lib/xmp/xmp-adjustment-restore.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
import { AdjustmentClipboardService } from '../../projects/maple-common/src/lib/editor/copy-paste/adjustment-clipboard.service';
import { BatchSyncService } from '../../projects/maple-common/src/lib/editor/copy-paste/batch-sync.service';
import {
  buildTransferPatch,
  type AdjustmentTransferRequest,
} from '../../projects/maple-common/src/lib/editor/copy-paste/adjustment-transfer';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import type { WhiteBalancePreset } from '../../projects/maple-common/src/lib/generated/white-balance-presets.generated';
import { workflowExportPixels as pixels } from './workflow-export-pixels';
import { control } from './self-hosted-editor-history';

interface Source {
  key: string;
  path: string;
  id: string;
  library: ApiFolder;
}
interface Saved {
  xml: string;
  original: number[];
}
async function environment(sources: readonly Source[]) {
  const app = await createApplication({
    providers: [provideSelfHostedWorkspace(), provideHttpClient(withFetch()), provideRouter([])],
  });
  // Seed the catalog inputs from the actual server fixture. All reads, editor
  // commands, persistence, byte loading, batch jobs and render services are real.
  const store = app.injector.get(LibraryStore);
  store.registeredFolders.set([sources[0].library]);
  store.assets.set(
    sources.map((source) => ({
      id: `workflow-fixture:${source.key}/photo.dng`,
      filename: 'photo.dng',
      folderId: source.library.id,
      rating: 0,
      flag: 'unflagged' as const,
      colorLabel: null,
      keywords: [],
      thumbnailGradient: '',
      aspectRatio: 1,
    })),
  );
  const library = app.injector.get(LibraryStateService);
  const id = store.assets()[0].id;
  library.focusedAssetId.set(id);
  await app.injector.get(XmpAdjustmentRestoreService).restoreForAsset(id);
  app.injector.get(EditorStateService).bind(id);
  app.injector.get(GpuLiveRenderGate).apply(false);
  return { app, library, id };
}
/** Actual HTTP original/sidecars, SQLite jobs and production editor — no substitutes. */
export async function selfHostedWhiteBalance(mode: WhiteBalancePreset | 'Sampled') {
  const input = new XmpSerializerService().serialize({
    ...defaultAdjustmentModel(),
    whiteBalancePreset: mode === 'Custom' ? 'As Shot' : 'Custom',
    wbSource: mode === 'Custom' ? 'AsShot' : 'Manual',
    temperature: 4800,
    tint: 8,
  });
  const source = await control<Source>('/workflow-fixture', { xml: input, synthetic: true });
  const target = await control<Source>('/workflow-fixture', { xml: null, synthetic: true });
  const sources = [source, target];
  const f = await environment(sources);
  let reopened: Awaited<ReturnType<typeof environment>> | undefined;
  const read = () => control<Saved>(`/workflow-fixture/${source.key}`);
  try {
    const editor = f.app.injector.get(EditorStateService);
    const pipeline = f.app.injector.get(RawPipelineService);
    const parser = f.app.injector.get(XmpParserService);
    const bytes = await f.library.bytesForAsset(f.id);
    const camera = await pipeline.decode(bytes, 'dng', '', 64, true);
    f.library.seedAsShotWhiteBalance(f.id, camera.asShotTemperature, camera.asShotTint);
    const before = JSON.stringify(f.library.adjustmentFor(f.id)());
    const changed =
      mode === 'Sampled'
        ? await editor.sampleWhiteBalanceAt(f.id, 0.25, 0.75)
        : await editor.applyWhiteBalancePreset(f.id, mode);
    await f.library.flushPendingXmpWrites();
    const applied = JSON.stringify(f.library.adjustmentFor(f.id)());
    const saved = await read();
    const exported = await pixels(pipeline, bytes, saved.xml);
    editor.undo();
    await f.library.flushPendingXmpWrites();
    const undone = JSON.stringify(f.library.adjustmentFor(f.id)()) === before;
    editor.redo();
    await f.library.flushPendingXmpWrites();
    const redone = JSON.stringify(f.library.adjustmentFor(f.id)()) === applied;
    const redoneXml = (await read()).xml;
    const clipboard = f.app.injector.get(AdjustmentClipboardService);
    clipboard.copyFrom(f.id, 'photo.dng', f.library.adjustmentFor(f.id)());
    const request: AdjustmentTransferRequest = {
      sourceAssetId: f.id,
      source: clipboard.entry()!.model,
      groups: ['white_balance'],
      relativeWhiteBalance: false,
    };
    const targetId = `workflow-fixture:${target.key}/photo.dng`;
    const batch = f.app.injector.get(BatchSyncService);
    const summary = await batch.apply([targetId], buildTransferPatch(request), request);
    if (!summary || summary.failed.length) throw Error(batch.error() ?? JSON.stringify(summary));
    const copied = await control<Saved>(`/workflow-fixture/${target.key}`);
    // A fresh root reads the server sidecar rather than reuse an edited model.
    reopened = await environment(sources);
    const reopenedXml = reopened.app.injector
      .get(XmpSerializerService)
      .serialize(reopened.library.adjustmentFor(f.id)());
    return {
      changed,
      undone,
      redone,
      roundtrip:
        JSON.stringify(parser.parseAdjustmentModel(reopenedXml).model) ===
        JSON.stringify(parser.parseAdjustmentModel(saved.xml).model),
      redoPixels: (await pixels(pipeline, bytes, redoneXml)) === exported,
      reopenPixels:
        (await pixels(reopened.app.injector.get(RawPipelineService), bytes, reopenedXml)) ===
        exported,
      copyApplied: summary.applied.length === 1 && summary.applied[0] === targetId,
      copyPixels: (await pixels(pipeline, bytes, copied.xml)) === exported,
      originalUnchanged:
        saved.original.length === bytes.length && saved.original.every((v, i) => v === bytes[i]),
      copyOriginalUnchanged:
        copied.original.length === bytes.length && copied.original.every((v, i) => v === bytes[i]),
      model: parser.parseAdjustmentModel(saved.xml).model,
      copiedModel: parser.parseAdjustmentModel(copied.xml).model,
    };
  } finally {
    reopened?.app.destroy();
    f.app.destroy();
  }
}
