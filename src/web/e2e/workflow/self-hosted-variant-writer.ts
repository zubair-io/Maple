import { firstValueFrom } from 'rxjs';
import { stage, control } from './self-hosted-editor-history';
import { WorkflowApiService } from '../../projects/maple-common/src/lib/api/workflow-api.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../../projects/maple-common/src/lib/workspace/workspace-persistence';
import { SelfHostedWorkflowWriterService } from '../../projects/maple-common/src/lib/xmp/self-hosted-workflow-writer.service';
import { SidecarIdbCache } from '../../projects/maple-common/src/lib/xmp/sidecar-idb-cache';
import { workflowSidecarKey } from '../../projects/maple-common/src/lib/xmp/workflow-sidecar-binding';
import type { AdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';

export async function selfHostedVariantWriter(input: string, scenario: string) {
  const f = await stage(input);
  const { app, source, core, parser, sidecars, library } = f;
  const api = app.injector.get(WorkflowApiService);
  const persistence = app.injector.get(SERVER_WORKSPACE_PERSISTENCE)!;
  const writer = app.injector.get(SelfHostedWorkflowWriterService);
  const variantId = crypto.randomUUID();
  const read = () => firstValueFrom(api.read(source.path, variantId));
  const culling = { rating: 3, flag: 'pick' as const, colorLabel: null, keywords: ['kept'] };
  const before = library.adjustmentFor(f.id)();
  const after = (exposure: number): AdjustmentModel => ({ ...before, exposure });
  const capture = (exposure: number, id = variantId) =>
    sidecars.commitSemantic(
      f.id,
      source.path,
      {
        before,
        after: after(exposure),
        culling,
        cullingPatch: culling,
        action: 'adjustment',
        label: 'Exposure',
      },
      id,
    );
  try {
    if (scenario === 'missing') {
      let rejected = false;
      try {
        await capture(1.25);
      } catch {
        rejected = true;
      }
      const original = await control<{ xml: string; original: number[] }>(
        `/workflow-fixture/${source.key}`,
      );
      return {
        rejected,
        pending: writer.hasPending(source.path, variantId),
        primaryUnchanged: original.xml === input,
        original: original.original,
        branches: (await firstValueFrom(api.list(source.path))).length,
      };
    }
    await firstValueFrom(
      api.create(source.path, {
        schemaVersion: 1,
        variantId,
        variantName: 'Night',
        snapshots: [],
        history: [],
      }),
    );
    writer.beginModel(source.path, before, variantId);
    writer.noteModel(source.path, after(9));
    const modelIsolated =
      writer.latestModel(source.path, variantId)?.exposure === before.exposure &&
      writer.latestModel(source.path) === undefined;
    writer.endModel(source.path, variantId);
    if (scenario === 'lost') {
      await control(`/workflow-fixture/${source.key}/lose-response`, {});
      let rejected = false;
      try {
        await capture(1.25);
      } catch {
        rejected = true;
      }
      if (!rejected || !writer.hasPending(source.path, variantId))
        throw Error('Lost accepted acknowledgement did not retain frozen branch action');
      await sidecars.retrySemantic(source.path, variantId);
    } else {
      await capture(1.25);
    }
    const edited = await read();
    const initialHistoryCount = (await core.read(edited))?.history.length;
    const snapshot = {
      id: crypto.randomUUID(),
      name: 'Exposure checkpoint',
      createdAtMs: Date.now(),
      adjustmentXmp: await core.checkpoint(edited),
    };
    await sidecars.publishWorkflow(
      f.id,
      source.path,
      () =>
        firstValueFrom(
          persistence.snapshotSidecar(source.path, edited, snapshot, undefined, variantId),
        ),
      variantId,
    );
    await capture(-0.5);
    const changed = await read();
    await sidecars.publishWorkflow(
      f.id,
      source.path,
      () =>
        firstValueFrom(
          persistence.restoreSidecar(
            source.path,
            changed,
            {
              id: crypto.randomUUID(),
              createdAtMs: Date.now(),
              action: 'snapshot-restore',
              label: 'Restore Exposure checkpoint',
              adjustmentXmp: snapshot.adjustmentXmp,
            },
            variantId,
          ),
        ),
      variantId,
    );
    const restored = await read();
    const checkpoint = await core.checkpoint(restored);
    // Route ordinary publication through the production write-through store.
    await sidecars.write(source.path, checkpoint, variantId);
    const published = await firstValueFrom(api.read(source.path, variantId));
    const original = await control<{ xml: string; original: number[]; changes: unknown[] }>(
      `/workflow-fixture/${source.key}`,
    );
    const cache = new SidecarIdbCache();
    const cached = await cache.get(workflowSidecarKey(source.path, variantId));
    const primaryCache = await cache.get(source.path);
    const record = await core.read(published);
    return {
      primaryUnchanged: original.xml === input,
      original: original.original,
      primaryChanges: original.changes.length,
      initialHistoryCount,
      modelIsolated,
      variantId: record?.variantId,
      expectedId: variantId,
      history: record?.history.map((entry) => ({
        action: entry.action,
        exposure: parser.parseAdjustmentModel(entry.adjustmentXmp).model.exposure,
      })),
      snapshots: record?.snapshots,
      expectedSnapshot: snapshot,
      exposure: parser.parseAdjustmentModel(published).model.exposure,
      culling: parser.parseCulling(published),
      foreign: published.includes(
        '<vendor:Audit xmlns:vendor="urn:maple:test:opaque"> exact &amp; kept </vendor:Audit>',
      ),
      cacheExact: cached?.xml === published,
      primaryCacheIsolated: primaryCache === null,
      pending: writer.hasPending(source.path, variantId),
      discovered: (await firstValueFrom(api.list(source.path)))
        .map((branch) => branch.variantId)
        .sort(),
    };
  } finally {
    app.destroy();
  }
}
