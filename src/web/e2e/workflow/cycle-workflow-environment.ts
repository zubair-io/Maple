import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { provideSelfHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/self-hosted-workspace.providers';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { fsAccessSettleWrites } from '../../projects/maple-common/src/lib/folder-access/fs-access-backend';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { XmpAdjustmentRestoreService } from '../../projects/maple-common/src/lib/xmp/xmp-adjustment-restore.service';
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
import type { ApiFolder } from '../../projects/maple-common/src/lib/workspace/server-library-io';
import { control } from './self-hosted-editor-history';

export type CycleDeployment = 'Hosted' | 'Self Hosted';
interface Source {
  key: string;
  library: ApiFolder;
}
export interface CycleSaved {
  xml: string;
  original: number[];
}
export async function cycleApplication(deployment: CycleDeployment) {
  return createApplication({
    providers: [
      deployment === 'Hosted' ? provideHostedWorkspace() : provideSelfHostedWorkspace(),
      provideHttpClient(withFetch()),
      provideRouter([]),
    ],
  });
}

/** One owned RAW and sidecar persist through all 100 cycles; no test doubles. */
export async function cycleStorage(deployment: CycleDeployment, xml: string) {
  const source = await control<Source>('/workflow-fixture', { xml, synthetic: true });
  const original = (await control<CycleSaved>(`/workflow-fixture/${source.key}`)).original;
  const root = await navigator.storage.getDirectory();
  const name = 'maple-cycle-' + crypto.randomUUID();
  const native =
    deployment === 'Hosted' ? await root.getDirectoryHandle(name, { create: true }) : null;
  const folder = native ? { native, name, read: true, write: true } : null;
  const bootstrap = await cycleApplication(deployment);
  try {
    if (folder) {
      const access = bootstrap.injector.get(FolderAccessService);
      await access.writeFile(folder, 'photo.dng', new Uint8Array(original));
      await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(xml));
      await access.settleWrites(folder);
    }
  } finally {
    bootstrap.destroy();
  }
  return {
    original: new Uint8Array(original),
    async open() {
      const app = await cycleApplication(deployment);
      try {
        const library = app.injector.get(LibraryStateService);
        if (folder) await library.openFolder(folder);
        else {
          const store = app.injector.get(LibraryStore);
          store.registeredFolders.set([source.library]);
          store.assets.set([
            {
              id: `workflow-fixture:${source.key}/photo.dng`,
              filename: 'photo.dng',
              folderId: source.library.id,
              rating: 0,
              flag: 'unflagged',
              colorLabel: null,
              keywords: [],
              thumbnailGradient: '',
              aspectRatio: 1,
            },
          ]);
        }
        const id = library.assets()[0]?.id;
        if (!id) throw Error('Cycle fixture did not load');
        library.focusedAssetId.set(id);
        if (!folder) await app.injector.get(XmpAdjustmentRestoreService).restoreForAsset(id);
        const editor = app.injector.get(EditorStateService);
        editor.bind(id);
        app.injector.get(GpuLiveRenderGate).apply(false);
        return { app, library, editor, id };
      } catch (error) {
        app.destroy();
        throw error;
      }
    },
    async read(): Promise<CycleSaved> {
      if (!folder) return control<CycleSaved>(`/workflow-fixture/${source.key}`);
      const app = await cycleApplication(deployment);
      try {
        const access = app.injector.get(FolderAccessService);
        return {
          xml: new TextDecoder().decode(await access.readFile(folder, 'photo.xmp')),
          original: [...(await access.readFile(folder, 'photo.dng'))],
        };
      } finally {
        if (folder) {
          const access = app.injector.get(FolderAccessService);
          await access.settleWrites(folder);
        }
        app.destroy();
      }
    },
    async dispose() {
      if (folder) {
        await fsAccessSettleWrites(folder);
        await root.removeEntry(name, { recursive: true });
      }
      // Server fixtures are removed by the owned workflow server at shutdown.
    },
  };
}
