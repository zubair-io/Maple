/** Browser-only delivery tests against real FileSystemHandles (isolated OPFS), not an encoder test. */
import { runBrowserRecipe } from '../projects/maple-common/src/lib/export/browser-recipe-runner';
import { DEFAULT_EXPORT_RECIPE } from '../projects/maple-common/src/lib/generated/export-recipe.generated';
import {
  readExportQueue,
  saveExportQueue,
  type RecipeQueueRecord,
} from '../projects/maple-common/src/lib/export/export-recipe-store';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function write(dir: FileSystemDirectoryHandle, name: string, content: string) {
  const file = await dir.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  await stream.write(content);
  await stream.close();
  return file;
}
async function text(dir: FileSystemDirectoryHandle, name: string) {
  return (await (await dir.getFileHandle(name)).getFile()).text();
}
async function record(): Promise<RecipeQueueRecord> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(`recipe-${crypto.randomUUID()}`, {
    create: true,
  });
  const source = await write(directory, 'original.dng', 'original bytes');
  return {
    id: crypto.randomUUID(),
    serverJobId: null,
    cancelled: false,
    directoryHandle: directory,
    recipe: {
      ...DEFAULT_EXPORT_RECIPE,
      destination: 'directory',
      directory: 'browser folder',
      overwritePolicy: 'error',
    },
    targets: [
      {
        id: 'source',
        filename: 'original.dng',
        sourceHandle: source,
        path: null,
        xmp: '<immutable-exposure/>',
        filmLook: '',
        index: 7,
        capturedAt: null,
      },
    ],
    entries: [{ id: 'source', status: 'pending' }],
  };
}
function context(name = 'output.jpg') {
  return {
    filename: async () => name,
    render: async () => ({
      blob: new Blob(['rendered pixels']),
      width: 2,
      height: 2,
      extension: 'jpg',
    }),
    save: saveExportQueue,
    cancelled: () => false,
    progress: () => {},
  };
}
export async function directoryCrash(): Promise<void> {
  const value = await record();
  const ctx = context();
  ctx.save = async (queue) => {
    if (queue.entries[0].status === 'applied') throw new Error('simulated lost acknowledgement');
    await saveExportQueue(queue);
  };
  try {
    await runBrowserRecipe(value, ctx);
    throw new Error('Crash injection did not run');
  } catch (error) {
    check(String(error).includes('lost acknowledgement'), 'Unexpected crash failure');
  }
  check(
    (await readExportQueue())!.entries[0].status === 'writing',
    'Write journal must precede publication',
  );
  check(
    (await text(value.directoryHandle!, 'output.jpg')) === 'rendered pixels',
    'Browser did not publish bytes',
  );
}
export async function directoryReload(): Promise<void> {
  const value = (await readExportQueue())!;
  check(
    !!value.directoryHandle && !!value.targets[0].sourceHandle,
    'IndexedDB did not retain real file handles',
  );
  const ctx = context();
  ctx.render = async () => {
    throw new Error('A published output must never re-render after reload');
  };
  await runBrowserRecipe(value, ctx);
  check(
    value.entries[0].status === 'applied',
    'Hash recovery did not acknowledge the published output',
  );
  check(
    (await text(value.directoryHandle!, 'original.dng')) === 'original bytes',
    'Original was modified',
  );
}
export async function directoryPolicies(): Promise<void> {
  const value = await record();
  const dir = value.directoryHandle!;
  await write(dir, 'output.jpg', 'existing delivery');
  await runBrowserRecipe(value, context());
  check(value.entries[0].status === 'failed', 'Error policy must report collisions');
  check(
    (await text(dir, 'output.jpg')) === 'existing delivery',
    'Collision changed existing bytes',
  );
  value.entries = [{ id: 'source', status: 'pending' }];
  value.recipe = { ...value.recipe, overwritePolicy: 'skip' };
  const skip = context();
  skip.render = async () => {
    throw new Error('Skip must avoid encoding');
  };
  await runBrowserRecipe(value, skip);
  check(value.entries[0].status === 'skipped', 'Skip policy should complete without encoding');
  value.entries = [{ id: 'source', status: 'pending' }];
  value.recipe = { ...value.recipe, overwritePolicy: 'replace' };
  await runBrowserRecipe(value, context());
  check(
    value.entries[0].status === 'applied' && (await text(dir, 'output.jpg')) === 'rendered pixels',
    'Explicit replace failed',
  );
  value.entries = [{ id: 'source', status: 'pending' }];
  await runBrowserRecipe(value, context('original.dng'));
  check(
    value.entries[0].status === 'failed' && (await text(dir, 'original.dng')) === 'original bytes',
    'Original identity guard failed',
  );
}
async function exists(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
}
export async function directoryCheckpointFailure(): Promise<void> {
  const value = await record();
  const ctx = context();
  ctx.save = async (queue) => {
    if (queue.entries[0].status === 'writing') throw new Error('storage unavailable');
    await saveExportQueue(queue);
  };
  try {
    await runBrowserRecipe(value, ctx);
    throw new Error('Expected persistence failure');
  } catch (error) {
    check(String(error).includes('storage unavailable'), 'Persistence error was swallowed');
  }
  check(
    !(await exists(value.directoryHandle!, 'output.jpg')),
    'Output was created without a durable checkpoint',
  );
}
export async function directoryCancelAndConflict(): Promise<void> {
  const value = await record();
  const dir = value.directoryHandle!;
  value.targets.push({ ...value.targets[0], id: 'second', index: 19 });
  value.entries.push({ id: 'second', status: 'pending' });
  const ctx = context();
  let cancelled = false;
  let rendered = 0;
  ctx.filename = async (target?: { index: number }) => `output_${target!.index}.jpg`;
  ctx.render = async () => {
    rendered++;
    return { blob: new Blob(['pixels']), width: 2, height: 2, extension: 'jpg' };
  };
  ctx.cancelled = () => cancelled;
  ctx.progress = () => {
    cancelled = true;
  };
  await runBrowserRecipe(value, ctx);
  check(
    value.entries[0].status === 'applied' && value.entries[1].status === 'pending',
    'Cancellation must stop between photos',
  );
  cancelled = false;
  ctx.progress = () => {};
  await runBrowserRecipe(value, ctx);
  check(
    rendered === 2 && value.entries[1].status === 'applied',
    'Resume re-rendered completed work',
  );
  value.targets = [value.targets[0]];
  value.entries = [{ id: 'source', status: 'pending' }];
  value.recipe = { ...value.recipe, overwritePolicy: 'replace' };
  ctx.render = async () => {
    await write(dir, 'output_7.jpg', 'external edit');
    return { blob: new Blob(['new pixels']), width: 2, height: 2, extension: 'jpg' };
  };
  await runBrowserRecipe(value, ctx);
  check(
    value.entries[0].status === 'failed' && (await text(dir, 'output_7.jpg')) === 'external edit',
    'Concurrent change was overwritten',
  );
}
