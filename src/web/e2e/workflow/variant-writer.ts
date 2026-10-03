import { createEnvironmentInjector, Injector, type EnvironmentInjector } from '@angular/core';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { HostedWorkflowWriterService } from '../../projects/maple-common/src/lib/xmp/hosted-workflow-writer.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { WorkflowVariantStoreService } from '../../projects/maple-common/src/lib/xmp/workflow-variant-store.service';
import { WorkflowXmpService } from '../../projects/maple-common/src/lib/xmp/workflow-xmp.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { SidecarSaveStateService } from '../../projects/maple-common/src/lib/xmp/sidecar-save-state.service';
import type { MapleFolderHandle } from '../../projects/maple-common/src/lib/folder-access/folder-access.types';

const environment = () =>
  createEnvironmentInjector(
    [
      FolderAccessService,
      HostedWorkflowWriterService,
      XmpParserService,
      XmpSerializerService,
      WorkflowVariantStoreService,
      WorkflowXmpService,
      XmpStoreService,
      SidecarSaveStateService,
    ],
    Injector.NULL as EnvironmentInjector,
  );
const culling = { rating: 3, flag: 'pick' as const, colorLabel: null, keywords: ['kept'] };

export async function variantWriter(input: string, scenario: string) {
  const root = await navigator.storage.getDirectory();
  const directoryName = 'maple-selected-writer-' + crypto.randomUUID();
  const native = await root.getDirectoryHandle(directoryName, { create: true });
  const folder: MapleFolderHandle = { native, name: directoryName, read: true, write: true };
  const env = environment();
  const access = env.get(FolderAccessService);
  const core = env.get(WorkflowXmpService);
  const variants = env.get(WorkflowVariantStoreService);
  const writer = env.get(HostedWorkflowWriterService);
  const parser = env.get(XmpParserService);
  const id = crypto.randomUUID();
  const read = async (name: string) =>
    new TextDecoder().decode(await access.readFile(folder, name));
  try {
    if (access.backend !== 'fs-access') throw Error('Actual FS Access is required');
    await access.writeFile(folder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
    await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
    const branch = await variants.create(folder, 'photo.xmp', {
      schemaVersion: 1,
      variantId: id,
      variantName: 'Night',
      snapshots: [],
      history: [],
    });
    const originalBranch = await read(branch.filename);
    const model = { ...defaultAdjustmentModel(), ...parser.parseAdjustmentModel(input).model };
    const publish = (exposure: number) =>
      writer.write(
        folder,
        branch.filename,
        { ...model, exposure },
        culling,
        undefined,
        undefined,
        id,
      );
    const fixture = {
      env,
      native,
      folder,
      access,
      core,
      variants,
      writer,
      parser,
      id,
      input,
      branch,
      originalBranch,
      model,
      read,
      publish,
    };
    if (scenario === 'queued') return await queuedWriter(fixture);
    writer.capture(
      folder,
      branch.filename,
      { ...model, exposure: 1.25 },
      culling,
      'adjustment',
      'Exposure',
    );

    if (scenario === 'missing' || scenario === 'identity')
      return await refusedWriter(fixture, scenario);
    return await roundtripWriter(fixture, scenario);
  } finally {
    env.destroy();
    await root.removeEntry(directoryName, { recursive: true });
  }
}

interface VariantFixture {
  env: EnvironmentInjector;
  native: FileSystemDirectoryHandle;
  folder: MapleFolderHandle;
  access: FolderAccessService;
  core: WorkflowXmpService;
  variants: WorkflowVariantStoreService;
  writer: HostedWorkflowWriterService;
  parser: XmpParserService;
  id: string;
  input: string;
  branch: { filename: string };
  originalBranch: string;
  model: ReturnType<typeof defaultAdjustmentModel>;
  read: (name: string) => Promise<string>;
  publish: (exposure: number) => Promise<string>;
}
async function queuedWriter(f: VariantFixture) {
  const { env, folder, id, model, read, branch, access, input, parser, core } = f;
  const store = env.get(XmpStoreService);
  await store.bindVariant('photo', folder, 'photo.dng', id);
  const selected = store.bindingFor('photo', folder, 'photo.dng');
  store.scheduleWrite('photo', folder, 'photo.dng', { ...model, exposure: 1.25 }, culling);
  await store.commitSemantic(
    'photo',
    folder,
    'photo.dng',
    { ...model, exposure: 1.25 },
    culling,
    'adjustment',
    'Exposure',
    selected,
  );
  store.scheduleWrite('photo', folder, 'photo.dng', { ...model, exposure: 2.5 }, culling);
  // Switching first settles the already-bound old preview write.
  await store.bindVariant('photo', folder, 'photo.dng', 'primary');
  // A captured old gesture still owns the sibling after selection changes.
  await store.commitSemantic(
    'photo',
    folder,
    'photo.dng',
    { ...model, exposure: -0.5 },
    culling,
    'adjustment',
    'Earlier gesture',
    selected,
  );
  const current = await read(branch.filename);
  return {
    primaryUnchanged: (await read('photo.xmp')) === input,
    original: Array.from(await access.readFile(folder, 'photo.dng')),
    active: store.bindingFor('photo', folder, 'photo.dng').variantId,
    exposure: parser.parseAdjustmentModel(current).model.exposure,
    history: (await core.read(current))?.history.map(
      (entry) => parser.parseAdjustmentModel(entry.adjustmentXmp).model.exposure,
    ),
  };
}
async function refusedWriter(f: VariantFixture, scenario: string) {
  const { native, branch, access, folder, input, read, publish } = f;
  await native.removeEntry(branch.filename);
  if (scenario === 'identity')
    await access.writeFile(folder, branch.filename, new TextEncoder().encode(input));
  const before = scenario === 'identity' ? await read(branch.filename) : null;
  let rejected = false;
  try {
    await publish(1.25);
  } catch {
    rejected = true;
  }
  const exists = (await access.listEntries(folder)).some((entry) => entry.name === branch.filename);
  return {
    rejected,
    branchUnchanged: before === null ? !exists : (await read(branch.filename)) === before,
    primaryUnchanged: (await read('photo.xmp')) === input,
    original: Array.from(await access.readFile(folder, 'photo.dng')),
  };
}
async function roundtripWriter(f: VariantFixture, scenario: string) {
  const {
    native,
    branch,
    access,
    folder,
    originalBranch,
    publish,
    core,
    variants,
    id,
    writer,
    model,
    parser,
    input,
    read,
  } = f;
  if (scenario === 'retry') {
    await native.removeEntry(branch.filename);
    await native.getDirectoryHandle(branch.filename, { create: true });
    let rejected = false;
    try {
      await publish(1.25);
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error('Real filesystem obstruction unexpectedly published');
    await native.removeEntry(branch.filename, { recursive: true });
    await access.writeFile(folder, branch.filename, new TextEncoder().encode(originalBranch));
  }
  const edited = await publish(2.5);
  const editedRecord = await core.read(edited);
  const snapshot = {
    id: crypto.randomUUID(),
    name: 'Exposure checkpoint',
    createdAtMs: Date.now(),
    adjustmentXmp: await core.checkpoint(edited),
  };
  const saved = await variants.saveSnapshot(folder, 'photo.xmp', id, edited, snapshot);
  writer.capture(
    folder,
    branch.filename,
    { ...model, exposure: -0.5 },
    culling,
    'adjustment',
    'Exposure',
  );
  const changed = await publish(-0.5);
  const entry = {
    id: crypto.randomUUID(),
    createdAtMs: Date.now(),
    action: 'snapshot-restore',
    label: 'Restore Exposure checkpoint',
    adjustmentXmp: snapshot.adjustmentXmp,
  };
  const restored = await variants.restore(folder, 'photo.xmp', id, changed, entry);
  // An ordinary preview after restore must preserve this branch's snapshots and tape.
  const preview = await publish(2.75);
  const reopenedEnv = environment();
  try {
    const reopened = await reopenedEnv
      .get(WorkflowVariantStoreService)
      .read(folder, 'photo.xmp', id);
    const workflow = await core.read(preview);
    return {
      primaryUnchanged: (await read('photo.xmp')) === input,
      original: Array.from(await access.readFile(folder, 'photo.dng')),
      variantId: workflow?.variantId,
      expectedId: id,
      history: workflow?.history.map((item) => ({
        action: item.action,
        exposure: parser.parseAdjustmentModel(item.adjustmentXmp).model.exposure,
      })),
      initialHistoryCount: editedRecord?.history.length,
      snapshots: workflow?.snapshots,
      expectedSnapshot: snapshot,
      savedSnapshot: (await core.read(saved))?.snapshots[0],
      restoredExposure: parser.parseAdjustmentModel(restored).model.exposure,
      finalExposure: parser.parseAdjustmentModel(preview).model.exposure,
      foreign: preview.includes(
        '<vendor:Audit xmlns:vendor="urn:maple:test:opaque"> exact &amp; kept </vendor:Audit>',
      ),
      culling: parser.parseCulling(preview),
      reopened: reopened === preview,
    };
  } finally {
    reopenedEnv.destroy();
  }
}
