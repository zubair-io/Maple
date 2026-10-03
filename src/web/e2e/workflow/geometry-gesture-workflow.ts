import { createComponent } from '@angular/core';
import { type CycleDeployment } from './cycle-workflow-environment';
import { lensGestureStorage } from './lens-gesture-storage';
import {
  GeometryPanelComponent,
  GEOMETRY_SLIDERS,
  type GeometryField,
} from '../../projects/maple-common/src/lib/components/editor/geometry-panel.component';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { cycleApplication } from './cycle-workflow-environment';

/** Actual geometry panel, immediate edits, Undo and real OPFS/API XMP (#4121). */
export async function geometryGestureWorkflow(deployment: CycleDeployment) {
  const owner = await cycleApplication(deployment);
  const input = owner.injector.get(XmpSerializerService).serialize(defaultAdjustmentModel());
  const parser = owner.injector.get(XmpParserService);
  const active = await lensGestureStorage(deployment, input);
  const ref = createComponent(GeometryPanelComponent, { environmentInjector: active.app.injector });
  const panel = ref.instance;
  const defaults = defaultAdjustmentModel();
  const evidence: string[] = [];
  const assert = (ok: boolean, message: string) => {
    if (!ok) throw Error(`${deployment}: ${message}`);
  };
  const saved = async (index: number, field: GeometryField) =>
    ({ ...defaults, ...parser.parseAdjustmentModel((await active.read(index)).xml).model })[field];
  try {
    for (const { field } of GEOMETRY_SLIDERS) {
      const first = field === 'perspectiveScale' ? 112 : 12;
      const last = field === 'perspectiveScale' ? 117 : 17;
      for (const route of ['other', 'roundtrip', 'none'] as const) {
        await active.focus(active.ids[0]);
        panel.onDragStart();
        panel.onValueChange(field, first);
        await active.library.flushPendingXmpWrites();
        assert((await saved(0, field)) === first, `${field} initial tick was not immediate`);
        active.library.focusedAssetId.set(route === 'none' ? null : active.ids[1]);
        if (route === 'roundtrip') active.library.focusedAssetId.set(active.ids[0]);
        const focused = active.library.focusedAssetId();
        if (focused) active.editor.bind(focused);
        else active.editor.endEdit();
        // Binding legitimately completes A's transaction/history publication.
        await active.library.flushPendingXmpWrites();
        const before = await Promise.all([active.read(0), active.read(1)]);
        panel.onValueChange(field, last);
        panel.onDragEnd();
        active.editor.endEdit();
        await active.library.flushPendingXmpWrites();
        const after = await Promise.all([active.read(0), active.read(1)]);
        assert(
          after.every((value, index) => value.xml === before[index].xml),
          `${field}/${route} changed a sidecar after focus`,
        );
        evidence.push(`${field}/${route}: valid A tick retained, late tick discarded, B unchanged`);
      }
      await active.focus(active.ids[0]);
      panel.onReset(field);
      await active.library.flushPendingXmpWrites();
      active.editor.bind(active.ids[0]);
      panel.onDragStart();
      panel.onValueChange(field, first);
      panel.onValueChange(field, last);
      panel.onDragEnd();
      await active.library.flushPendingXmpWrites();
      assert((await saved(0, field)) === last, `${field} normal gesture missed A`);
      assert((await saved(1, field)) === defaults[field], `${field} normal gesture changed B`);
      assert(active.editor.undoHistory().length === 1, `${field} did not create one Undo`);
      active.editor.undo();
      await active.library.flushPendingXmpWrites();
      assert((await saved(0, field)) === defaults[field], `${field} Undo missed A`);
      panel.onDragStart();
      panel.onValueChange(field, first);
      panel.onReset(field);
      panel.onValueChange(field, last);
      panel.onDragEnd();
      await active.library.flushPendingXmpWrites();
      assert((await saved(0, field)) === defaults[field], `${field} stale release overwrote reset`);
      assert((await saved(1, field)) === defaults[field], `${field} reset changed B`);
      evidence.push(`${field}/normal, Undo, reset: correct A sidecar and unchanged B`);
    }
    for (const index of [0, 1])
      assert(
        JSON.stringify((await active.read(index)).original) ===
          JSON.stringify(active.initial[index].original),
        'Original bytes changed',
      );
    return { deployment, evidence, originalBytesPreserved: true };
  } finally {
    ref.destroy();
    await active.dispose();
    owner.destroy();
  }
}
