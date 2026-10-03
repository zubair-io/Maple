import { createComponent } from '@angular/core';
import { cycleApplication, type CycleDeployment } from './cycle-workflow-environment';
import { lensGestureStorage } from './lens-gesture-storage';
import { LensCorrectionsPanelComponent } from '../../projects/maple-common/src/lib/components/editor/lens-corrections-panel.component';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';

/** Actual panel boundaries, Undo and real OPFS/API XMP; no sidecar doubles. */
export async function lensGestureWorkflow(deployment: CycleDeployment) {
  const owner = await cycleApplication(deployment);
  const input = owner.injector.get(XmpSerializerService).serialize(defaultAdjustmentModel());
  const parser = owner.injector.get(XmpParserService);
  const active = await lensGestureStorage(deployment, input);
  const ref = createComponent(LensCorrectionsPanelComponent, {
    environmentInjector: active.app.injector,
  });
  const panel = ref.instance;
  const evidence: string[] = [];
  const assert = (ok: boolean, message: string) => {
    if (!ok) throw Error(`${deployment}: ${message}`);
  };
  const savedValue = async (
    index: number,
    field: 'lensCorrectionDistortion' | 'lensCorrectionCa' | 'lensCorrectionVignetting',
  ) =>
    ({
      ...defaultAdjustmentModel(),
      ...parser.parseAdjustmentModel((await active.read(index)).xml).model,
    })[field];
  try {
    for (const [suffix, field] of [
      ['Distortion', 'lensCorrectionDistortion'],
      ['Ca', 'lensCorrectionCa'],
      ['Vignetting', 'lensCorrectionVignetting'],
    ] as const) {
      const start = `on${suffix}DragStart` as const;
      const change = `on${suffix}Change` as const;
      const end = `on${suffix}DragEnd` as const;
      const reset = `on${suffix}Reset` as const;
      for (const route of ['other', 'roundtrip', 'none'] as const) {
        await active.focus(active.ids[0]);
        const before = await Promise.all([active.read(0), active.read(1)]);
        panel[start]();
        panel[change](42);
        // Direct focus updates intentionally coalesce before any render/read.
        active.library.focusedAssetId.set(route === 'none' ? null : active.ids[1]);
        if (route === 'roundtrip') active.library.focusedAssetId.set(active.ids[0]);
        const focused = active.library.focusedAssetId();
        if (focused) active.editor.bind(focused);
        panel[change](17);
        panel[end]();
        active.editor.endEdit();
        await active.library.flushPendingXmpWrites();
        const after = await Promise.all([active.read(0), active.read(1)]);
        assert(
          after.every((saved, index) => saved.xml === before[index].xml),
          `${field}/${route} changed a sidecar`,
        );
        assert(active.editor.undoHistory().length === 0, `${field}/${route} created Undo`);
        evidence.push(`${field}/${route}: both sidecars unchanged, no Undo`);
      }
      await active.focus(active.ids[0]);
      panel[start]();
      panel[change](42);
      panel[change](17);
      panel[end]();
      active.editor.endEdit();
      await active.library.flushPendingXmpWrites();
      assert((await savedValue(0, field)) === 17, `${field} did not save to A`);
      assert((await savedValue(1, field)) === 100, `${field} changed B`);
      assert(active.editor.undoHistory().length === 1, `${field} did not create one Undo`);
      active.editor.undo();
      await active.library.flushPendingXmpWrites();
      assert((await savedValue(0, field)) === 100, `${field} Undo did not restore A`);
      panel[start]();
      panel[change](42);
      panel[reset]();
      panel[change](17);
      panel[end]();
      active.editor.endEdit();
      await active.library.flushPendingXmpWrites();
      assert((await savedValue(0, field)) === 100, `${field} release overwrote reset`);
      assert((await savedValue(1, field)) === 100, `${field} reset changed B`);
      evidence.push(`${field}/normal, Undo, reset: correct A sidecar and unchanged B`);
    }
    for (const index of [0, 1]) {
      const saved = await active.read(index);
      assert(
        JSON.stringify(saved.original) === JSON.stringify(active.initial[index].original),
        'Original bytes changed',
      );
    }
    return { deployment, evidence, originalBytesPreserved: true };
  } finally {
    ref.destroy();
    await active.dispose();
    owner.destroy();
  }
}
