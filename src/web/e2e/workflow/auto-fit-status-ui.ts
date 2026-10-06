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
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
@Component({
  selector: 'auto-fit-qualification',
  imports: [ProfileSectionComponent, ImageCanvasComponent],
  template: `<main>
    <editor-profile-section /><editor-image-canvas style="display:flex;width:480px;height:320px" />
  </main>`,
})
class AutoFitQualification {
  @ViewChild(ImageCanvasComponent) canvas?: ImageCanvasComponent;
}
let active: {
  app: ApplicationRef;
  component: ComponentRef<AutoFitQualification>;
  host: HTMLElement;
  name: string;
} | null = null;
async function dispose() {
  const disposing = active;
  if (!disposing) return;
  try {
    await disposeProfileFixture(disposing);
  } finally {
    if (active === disposing) active = null;
  }
}
Object.assign(window, {
  autoFitStatusUI: {
    ready: true,
    async mount(files: string[], name?: string, gpu = false) {
      await dispose();
      const app = await createApplication({
        providers: [provideHostedWorkspace(), provideHttpClient(withFetch()), provideRouter([])],
      });
      app.injector.get(GpuLiveRenderGate).apply(gpu);
      const folder = await stageProfileFixture(app, files, 'maple-auto-fit-', name);
      const folderName = folder.name;
      const library = app.injector.get(LibraryStateService);
      await library.openFolder(folder);
      const first = library.assets().find((a) => a.filename === files[0]);
      if (!first) throw Error('Physical asset was not indexed');
      library.focusedAssetId.set(first.id);
      app.injector.get(EditorStateService).bind(first.id);
      const host = document.createElement('div');
      document.body.append(host);
      const component = createComponent(AutoFitQualification, {
        environmentInjector: app.injector,
        hostElement: host,
      });
      app.attachView(component.hostView);
      component.changeDetectorRef.detectChanges();
      active = { app, component, host, name: folderName };
      return folderName;
    },
    async focus(filename: string) {
      if (!active) throw Error('No Auto fixture mounted');
      const library = active.app.injector.get(LibraryStateService);
      const asset = library.assets().find((a) => a.filename === filename);
      if (!asset) throw Error('Physical asset missing: ' + filename);
      library.focusedAssetId.set(asset.id);
      active.app.injector.get(EditorStateService).bind(asset.id);
    },
    async state() {
      if (!active) throw Error('No Auto fixture mounted');
      const library = active.app.injector.get(LibraryStateService);
      const id = library.focusedAssetId()!;
      await active.app.injector.get(XmpStoreService).settleAsset(id);
      return {
        profile: library.adjustmentFor(id)().profile,
        gpuActive: active.component.instance.canvas?.gpuPresent.active() ?? false,
        autoFit: library.lensCorrectionsFor(id).autoFit,
      };
    },
    dispose,
  },
});
