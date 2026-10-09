import { cycleApplication, cycleStorage } from './cycle-workflow-environment';
import type { CycleDeployment } from './cycle-workflow-environment';
import { withWorkflowMetadata, foreignAudit } from './auto-tone-workflow';
import { workflowExportPixels } from './workflow-export-pixels';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { WorkflowXmpService } from '../../projects/maple-common/src/lib/xmp/workflow-xmp.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { WORKFLOW_HISTORY_LIMIT } from '../../projects/maple-common/src/lib/generated/workflow.generated';

/** #4090: actual visible editor gestures, durable fresh-root reload and RAW export. */
export async function repeatedWorkflow(deployment: CycleDeployment) {
  const owner = await cycleApplication(deployment);
  const parser = owner.injector.get(XmpParserService);
  const serializer = owner.injector.get(XmpSerializerService);
  const core = owner.injector.get(WorkflowXmpService);
  const pipeline = owner.injector.get(RawPipelineService);
  const input = withWorkflowMetadata(serializer.serialize(defaultAdjustmentModel()), 'A');
  const storage = await cycleStorage(deployment, input);
  const model = (xml: string) => JSON.stringify(parser.parseAdjustmentModel(xml).model);
  const pixels = (xml: string) => workflowExportPixels(pipeline, storage.original, xml);
  const evidence: { cycle: number; tool: string; value: number; historyCount: number }[] = [];
  const assert = (condition: boolean, cycle: number, message: string) => {
    if (!condition) throw Error(`${deployment}, cycle ${cycle}: ${message}`);
  };
  const checkSaved = (saved: Awaited<ReturnType<typeof storage.read>>, cycle: number) => {
    assert(
      parser.parseMetadata(saved.xml).caption === 'Caption A' &&
        saved.xml.includes(foreignAudit('A')),
      cycle,
      'Caption or exact foreign XML changed',
    );
    assert(
      saved.original.length === storage.original.length &&
        saved.original.every((value, index) => value === storage.original[index]),
      cycle,
      'Original bytes changed',
    );
  };
  try {
    for (let cycle = 1; cycle <= 100; cycle++) {
      const active = await storage.open();
      try {
        const before = await storage.read();
        checkSaved(before, cycle);
        assert(
          model(serializer.serialize(active.library.adjustmentFor(active.id)())) ===
            model(before.xml),
          cycle,
          'Fresh editor did not hydrate the previous sidecar',
        );
        const beforePixels = await pixels(before.xml);
        const tool = cycle % 2 ? 'exposure' : 'contrast';
        const value =
          tool === 'exposure' ? (cycle % 4 === 1 ? 0.75 : -0.5) : cycle % 4 === 2 ? 12 : -8;
        const label = `Cycle ${cycle} ${tool}`;
        active.editor.armTool(tool);
        active.editor.commit('adjustment', label);
        active.editor.setArmedDisplayValue(value);
        active.editor.endEdit();
        await active.library.flushPendingXmpWrites();
        const expected = serializer.serialize(active.library.adjustmentFor(active.id)());
        assert(
          active.library.adjustmentFor(active.id)()[tool] === value,
          cycle,
          'Visible control did not receive the requested value',
        );
        const saved = await storage.read();
        checkSaved(saved, cycle);
        assert(
          model(saved.xml) === model(expected),
          cycle,
          'Persisted model differs from visible edit',
        );
        assert(
          active.editor.undoHistory().length === 1 &&
            active.editor.undoHistory()[0].description === label,
          cycle,
          'Gesture did not create exactly one Undo boundary',
        );
        const exported = await pixels(saved.xml);
        assert(
          exported !== beforePixels,
          cycle,
          'Visible edit did not change actual export pixels',
        );
        const history = await core.read(saved.xml);
        assert(
          history?.history.length === Math.min((cycle - 1) * 3 + 1, WORKFLOW_HISTORY_LIMIT) &&
            history.history.at(-1)?.label === label &&
            history.history.at(-1)?.action === 'adjustment',
          cycle,
          'Committed history or bounded compaction drifted',
        );
        active.editor.undo();
        await active.library.flushPendingXmpWrites();
        const undone = await storage.read();
        checkSaved(undone, cycle);
        assert(
          model(undone.xml) === model(before.xml),
          cycle,
          'Undo did not restore complete model',
        );
        assert(
          (await pixels(undone.xml)) === beforePixels,
          cycle,
          'Undo export differs from before edit',
        );
        active.editor.redo();
        await active.library.flushPendingXmpWrites();
        const redone = await storage.read();
        checkSaved(redone, cycle);
        assert(
          model(redone.xml) === model(saved.xml),
          cycle,
          'Redo did not restore complete model',
        );
        assert(
          (await pixels(redone.xml)) === exported,
          cycle,
          'Redo export differs from committed edit',
        );
        const fresh = await storage.open();
        try {
          const reopened = fresh.app.injector
            .get(XmpSerializerService)
            .serialize(fresh.library.adjustmentFor(fresh.id)());
          assert(model(reopened) === model(saved.xml), cycle, 'Fresh-root reload lost edit state');
          assert(
            (await pixels(reopened)) === exported,
            cycle,
            'Reload export differs from committed edit',
          );
          const reread = await storage.read();
          checkSaved(reread, cycle);
          const retained = await fresh.app.injector.get(WorkflowXmpService).read(reread.xml);
          assert(
            retained?.history.length === Math.min(cycle * 3, WORKFLOW_HISTORY_LIMIT) &&
              retained.history.at(-1)?.action === 'redo' &&
              retained.history.at(-1)?.label === `Redo ${label}`,
            cycle,
            'Reopened durable history lost Undo/Redo semantics',
          );
          evidence.push({ cycle, tool, value, historyCount: retained!.history.length });
        } finally {
          await fresh.library.flushPendingXmpWrites();
          await fresh.library.flushPendingIndexWrites();
          fresh.library.cancelPendingPreviewWrites();
          fresh.app.destroy();
        }
      } finally {
        await active.library.flushPendingXmpWrites();
        await active.library.flushPendingIndexWrites();
        active.library.cancelPendingPreviewWrites();
        active.app.destroy();
      }
    }
    return {
      deployment,
      completed: evidence.length,
      expected: 100,
      historyLimit: WORKFLOW_HISTORY_LIMIT,
      cycles: evidence,
    };
  } finally {
    await storage.dispose();
    owner.destroy();
  }
}
