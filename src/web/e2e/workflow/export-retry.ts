import '@angular/compiler';
import { createEnvironmentInjector, Injector, type EnvironmentInjector } from '@angular/core';
import { ExportRecipeQueueService } from '../../projects/maple-common/src/lib/export/export-recipe-queue.service';
import { ExportRecipeRenderService } from '../../projects/maple-common/src/lib/export/export-recipe-render.service';
import { RecipeDirectoryAccessService } from '../../projects/maple-common/src/lib/export/recipe-directory-access.service';
import {
  readExportQueue,
  saveExportQueue,
  type RecipeTarget,
} from '../../projects/maple-common/src/lib/export/export-recipe-store';
import { DEFAULT_EXPORT_RECIPE } from '../../projects/maple-common/src/lib/generated/export-recipe.generated';
import type { Asset } from '../../projects/maple-common/src/lib/models/asset';

async function originalFixtures() {
  const root = await navigator.storage.getDirectory();
  const name = 'export-originals-' + crypto.randomUUID();
  const folder = await root.getDirectoryHandle(name, { create: true });
  const put = async (filename: string, contents: string) => {
    const handle = await folder.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    return handle;
  };
  const a = await put('A.jpg', 'original-A');
  const b = await put('1.jpg', 'original-B');
  const sidecar = await put('A.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
  const xmp = await (await sidecar.getFile()).text();
  const targets: RecipeTarget[] = [a, b].map((sourceHandle, index) => ({
    id: String(index),
    filename: sourceHandle.name,
    path: null,
    xmp,
    filmLook: '',
    capturedAt: null,
    index,
    sourceHandle,
  }));
  return { root, name, folder, put, a, b, sidecar, xmp, targets };
}

async function startScenario(
  scenario: string,
  env: EnvironmentInjector,
  fixture: Awaited<ReturnType<typeof originalFixtures>>,
  recipe: typeof DEFAULT_EXPORT_RECIPE,
) {
  const { folder, put, targets, a } = fixture;
  if (scenario === 'unrelated') {
    await put('3.jpg', 'previous-unrelated-output');
    targets.splice(1);
  }
  if (scenario === 'legacy-filtered') targets.splice(1);
  if (scenario === 'legacy' || scenario === 'legacy-filtered' || scenario === 'missing') {
    await saveExportQueue({
      id: 'legacy',
      recipe,
      targets,
      entries: targets.map((target) => ({ id: target.id, status: 'pending' })),
      cancelled: false,
      serverJobId: null,
      directoryHandle: folder,
      ...(scenario === 'missing' ? { protectedOriginals: [a, null] } : {}),
    });
    await env.get(ExportRecipeQueueService).resume();
  } else await env.get(ExportRecipeQueueService).start(targets as unknown as Asset[], recipe);
}

async function regression(scenario: string) {
  const fixture = await originalFixtures();
  const { root, name, folder, a, b, sidecar, xmp, targets } = fixture;
  const recipe = {
    ...DEFAULT_EXPORT_RECIPE,
    destination: 'directory' as const,
    directory: 'owned-test-folder',
    namingTemplate: '{n}.{ext}',
    overwritePolicy: 'replace' as const,
  };
  let renderCalls = 0;
  let failUnrelated = scenario === 'unrelated';
  const renderer = {
    capture: async () => targets,
    filename: async (target: RecipeTarget) =>
      scenario === 'unrelated' ? '3.jpg' : `${target.index + 1}.jpg`,
    // Publication guard is under test, not encoder pixels. Original and sidecar files are real.
    render: async (target: RecipeTarget) => {
      renderCalls++;
      if (failUnrelated) {
        failUnrelated = false;
        throw Error('Encoder failure before publication');
      }
      return { blob: new Blob(['export-' + target.id]), filename: 'unused.jpg' };
    },
  };
  const environment = () =>
    createEnvironmentInjector(
      [
        ExportRecipeQueueService,
        { provide: ExportRecipeRenderService, useValue: renderer },
        {
          provide: RecipeDirectoryAccessService,
          useValue: {
            resolve: async () => folder,
            permit: async () => {},
            captureSources: async () => {},
          },
        },
      ],
      Injector.NULL as EnvironmentInjector,
    );
  // A fresh queue per case; the service still performs actual IndexedDB persistence and locking.
  await saveExportQueue({
    id: 'empty',
    recipe,
    targets: [],
    entries: [],
    cancelled: false,
    serverJobId: null,
  });
  let env = environment();
  try {
    await startScenario(scenario, env, fixture, recipe);
    const first = await readExportQueue();
    await env.get(ExportRecipeQueueService).retryFailed();
    const retried = await readExportQueue();
    env.destroy();
    env = environment();
    await env.get(ExportRecipeQueueService).resume();
    await env.get(ExportRecipeQueueService).retryFailed();
    const reloaded = await readExportQueue();
    return {
      first: first?.entries,
      retried: retried?.entries,
      reloaded: reloaded?.entries,
      protectedCount: reloaded?.protectedOriginals?.length ?? null,
      a: await (await a.getFile()).text(),
      b: await (await b.getFile()).text(),
      sidecar: await (await sidecar.getFile()).text(),
      xmp,
      renderCalls,
      output:
        scenario === 'unrelated'
          ? await (await (await folder.getFileHandle('3.jpg')).getFile()).text()
          : null,
    };
  } finally {
    env.destroy();
    await root.removeEntry(name, { recursive: true });
  }
}
Object.assign(window, { exportOriginalRetryRegression: regression });
