import '@angular/compiler';
import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideSelfHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/self-hosted-workspace.providers';
import { ExportRecipeQueueService } from '../../projects/maple-common/src/lib/export/export-recipe-queue.service';
import {
  readExportQueue,
  saveExportQueue,
  type RecipeQueueRecord,
} from '../../projects/maple-common/src/lib/export/export-recipe-store';

const app = await createApplication({
  providers: [provideSelfHostedWorkspace(), provideHttpClient(withFetch()), provideRouter([])],
});
const queue = () => app.injector.get(ExportRecipeQueueService);
async function snapshot() {
  return { record: await readExportQueue(), error: queue().error() };
}
async function initial() {
  const response = await fetch('/workflow-fixture', { method: 'POST' });
  if (!response.ok) throw Error('Fixture failed');
  const fixture = await response.json();
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  // These targets are actual files/XMP returned by the owned HTTP fixture. This
  // qualifies queue transport/recovery; capture and image math are separate gates.
  const record: RecipeQueueRecord = {
    id,
    serverJobId: id,
    targets: fixture.targets,
    recipe: fixture.recipe,
    entries: fixture.targets.map((target: { id: string }) => ({
      id: target.id,
      status: 'pending',
    })),
    cancelled: false,
  };
  await saveExportQueue(record);
  await queue().resume();
  return { ...fixture, ...(await snapshot()) };
}
Object.assign(window, {
  selfHostedRetry: {
    initial,
    retry: async () => {
      await queue().retryFailed();
      return snapshot();
    },
    resume: async () => {
      await queue().resume();
      return snapshot();
    },
    snapshot,
  },
});
