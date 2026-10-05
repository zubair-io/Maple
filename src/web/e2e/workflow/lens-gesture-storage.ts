import {
  cycleApplication,
  type CycleDeployment,
  type CycleSaved,
} from './cycle-workflow-environment';
import { control } from './self-hosted-editor-history';
import { seedSelfHostedFixtures } from './self-hosted-fixture-catalog';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { XmpAdjustmentRestoreService } from '../../projects/maple-common/src/lib/xmp/xmp-adjustment-restore.service';
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
import type { ApiFolder } from '../../projects/maple-common/src/lib/workspace/server-library-io';

/** Two owned originals and real sidecars exercise cross-photo writes (#4103). */
export async function lensGestureStorage(deployment: CycleDeployment, xml: string) {
  const sources = await Promise.all(
    ['a', 'b'].map(() =>
      control<{ key: string; library: ApiFolder }>('/workflow-fixture', { xml, synthetic: true }),
    ),
  );
  const initial = await Promise.all(
    sources.map((source) => control<CycleSaved>(`/workflow-fixture/${source.key}`)),
  );
  const root = await navigator.storage.getDirectory();
  const name = 'maple-lens-gesture-' + crypto.randomUUID();
  const native =
    deployment === 'Hosted' ? await root.getDirectoryHandle(name, { create: true }) : null;
  const folder = native ? { native, name, read: true, write: true } : null;
  const app = await cycleApplication(deployment);
  const access = app.injector.get(FolderAccessService);
  const library: LibraryStateService = app.injector.get(LibraryStateService);
  async function dispose() {
    // XMP settles first; any index work it schedules must drain afterwards.
    const xmp = await Promise.allSettled([library.flushPendingXmpWrites()]);
    const index = await Promise.allSettled([library.flushPendingIndexWrites()]);
    app.destroy();
    const removal = folder
      ? await Promise.allSettled([root.removeEntry(name, { recursive: true })])
      : [];
    const failures = [...xmp, ...index, ...removal].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, 'Gesture storage cleanup failed');
  }
  try {
    if (folder) {
      for (const [index, letter] of ['a', 'b'].entries()) {
        await access.writeFile(folder, `${letter}.dng`, new Uint8Array(initial[index].original));
        await access.writeFile(folder, `${letter}.xmp`, new TextEncoder().encode(xml));
      }
      await library.openFolder(folder);
    } else {
      seedSelfHostedFixtures(app, sources);
    }
    const ids = folder
      ? ['a.dng', 'b.dng'].map(
          (filename) => library.assets().find((asset) => asset.filename === filename)?.id,
        )
      : library.assets().map((asset) => asset.id);
    if (!ids[0] || !ids[1]) throw Error('Both lens fixtures must load');
    const editor = app.injector.get(EditorStateService);
    async function focus(id: string | null) {
      library.focusedAssetId.set(id);
      if (id && !folder) await app.injector.get(XmpAdjustmentRestoreService).restoreForAsset(id);
      if (id) editor.bind(id);
    }
    await focus(ids[0]);
    app.injector.get(GpuLiveRenderGate).apply(false);
    return {
      app,
      library,
      editor,
      ids: ids as [string, string],
      focus,
      async read(index: number): Promise<CycleSaved> {
        if (!folder) return control<CycleSaved>(`/workflow-fixture/${sources[index].key}`);
        const letter = index === 0 ? 'a' : 'b';
        return {
          xml: new TextDecoder().decode(await access.readFile(folder, `${letter}.xmp`)),
          original: [...(await access.readFile(folder, `${letter}.dng`))],
        };
      },
      initial,
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Lens fixture setup and cleanup failed');
    }
    throw error;
  }
}
