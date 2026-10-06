import { disposeProfileFixture, stageProfileFixture } from './profile-physical-fixtures';
import {
  Component,
  createComponent,
  type ApplicationRef,
  ViewChild,
  type ComponentRef,
} from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { ProfileSectionComponent } from '../../projects/maple-common/src/lib/components/editor/profile-section.component';
import { ImageCanvasComponent } from '../../projects/maple-common/src/lib/components/image-canvas/image-canvas.component';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
@Component({
  selector: 'cold-profile-qualification',
  imports: [ProfileSectionComponent, ImageCanvasComponent],
  templateUrl: './cold-profile-ui.html',
  styleUrl: './cold-profile-ui.scss',
})
class ColdProfileQualification {
  @ViewChild(ImageCanvasComponent) canvas?: ImageCanvasComponent;
}
let pending = false;
let release: (() => void) | null = null;
let dispatched: string | undefined;
let edits: string[] = [];
let gateIntent: string | null = null;
let completed = false;
let active: {
  app: ApplicationRef;
  component: ComponentRef<ColdProfileQualification>;
  host: HTMLElement;
  name: string;
} | null = null;
function resetHarness() {
  release?.();
  release = null;
  pending = false;
  completed = false;
  dispatched = undefined;
  edits = [];
  gateIntent = null;
}
async function dispose() {
  resetHarness();
  const disposing = active;
  if (!disposing) return;
  try {
    await disposeProfileFixture(disposing);
  } finally {
    if (active === disposing) active = null;
  }
}
Object.assign(window, {
  coldProfileUI: {
    ready: true,
    async mount(files: string[], name?: string, gpu = false, hold = false) {
      await dispose();
      const app = await createApplication({
        providers: [provideHostedWorkspace(), provideHttpClient(withFetch()), provideRouter([])],
      });
      const host = document.createElement('div');
      try {
        app.injector.get(GpuLiveRenderGate).apply(gpu);
        pending = false;
        completed = false;
        dispatched = undefined;
        edits = [];
        gateIntent = null;
        const pipeline = app.injector.get(RawPipelineService);
        if (hold) {
          const barrier = new Promise<void>((resolve) => {
            release = resolve;
          });
          const decode = pipeline.decode.bind(pipeline);
          pipeline.decode = async (...args: Parameters<RawPipelineService['decode']>) => {
            if (dispatched === undefined) {
              dispatched = args[2];
              const frame = await decode(...args);
              pending = true;
              await barrier;
              return frame;
            }
            edits.push(args[2] ?? '');
            const frame = await decode(...args);
            completed = true;
            return frame;
          };
          const open = pipeline.openLiveSession.bind(pipeline);
          pipeline.openLiveSession = async (
            ...args: Parameters<RawPipelineService['openLiveSession']>
          ) => {
            dispatched = args[3];
            const frame = await open(...args);
            pending = true;
            await barrier;
            return frame;
          };
          const render = pipeline.renderLiveSession.bind(pipeline);
          pipeline.renderLiveSession = async (
            ...args: Parameters<RawPipelineService['renderLiveSession']>
          ) => {
            edits.push(args[0] ?? '');
            const result = await render(...args);
            completed = true;
            return result;
          };
        }
        const folder = await stageProfileFixture(app, files, 'maple-cold-profile-', name);
        const folderName = folder.name;
        const library = app.injector.get(LibraryStateService);
        await library.openFolder(folder);
        const first = library.assets().find((a) => a.filename === files[0]);
        if (!first) throw Error('Physical asset was not indexed');
        library.focusedAssetId.set(first.id);
        app.injector.get(EditorStateService).bind(first.id);
        document.body.append(host);
        const component = createComponent(ColdProfileQualification, {
          environmentInjector: app.injector,
          hostElement: host,
        });
        app.attachView(component.hostView);
        component.changeDetectorRef.detectChanges();
        const canvas = component.instance.canvas;
        if (!canvas) throw Error('Canvas missing');
        if (hold) {
          const mark = canvas.markColdOpenDone.bind(canvas);
          canvas.markColdOpenDone = () => {
            gateIntent = canvas.lastRenderedXmp;
            mark();
          };
        }
        active = { app, component, host, name: folderName };
        return folderName;
      } catch (error) {
        resetHarness();
        app.destroy();
        host.remove();
        throw error;
      }
    },
    async focus(filename: string) {
      if (!active) throw Error('No Auto fixture mounted');
      const library = active.app.injector.get(LibraryStateService);
      const asset = library.assets().find((a) => a.filename === filename);
      if (!asset) throw Error('Physical asset missing: ' + filename);
      library.focusedAssetId.set(asset.id);
      active.app.injector.get(EditorStateService).bind(asset.id);
    },
    authorWhiteBalance() {
      if (!active) throw Error('No physical fixture mounted');
      const library = active.app.injector.get(LibraryStateService);
      const editor = active.app.injector.get(EditorStateService);
      const id = library.focusedAssetId()!;
      editor.commit('adjustment', 'Custom white balance');
      library.updateAdjustment(id, { whiteBalancePreset: 'Custom', temperature: 4800, tint: 12 });
      editor.endEdit();
    },
    async state() {
      if (!active) throw Error('No Auto fixture mounted');
      const library = active.app.injector.get(LibraryStateService);
      const id = library.focusedAssetId()!;
      await active.app.injector.get(XmpStoreService).settleAsset(id);
      return {
        profile: library.adjustmentFor(id)().profile,
        whiteBalance: {
          preset: library.adjustmentFor(id)().whiteBalancePreset,
          temperature: library.adjustmentFor(id)().temperature,
          tint: library.adjustmentFor(id)().tint,
        },
        gpuActive: active.component.instance.canvas?.gpuPresent.active() ?? false,
        pending,
        completed,
        dispatched,
        edits,
        gateIntent,
        rendered: active.component.instance.canvas?.lastRenderedXmp,
        expected: active.component.instance.canvas?.serializeForRender(library.adjustmentFor(id)()),
        bitmap: !!active.component.instance.canvas?.imageBitmap(),
      };
    },
    release() {
      if (!release) throw Error('No pending frame');
      release();
      release = null;
    },
    dispose,
  },
});
