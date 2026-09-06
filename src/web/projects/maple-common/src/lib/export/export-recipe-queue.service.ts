import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Asset } from '../models/asset';
import type { BatchProgress } from '../editor/copy-paste/batch-sync';
import { parseExportRecipe, exportRecipeProblem } from '../generated/export-recipe.generated';
import { ExportRecipeRenderService } from './export-recipe-render.service';
import { EXPORT_RECIPE_SERVER, type ExportJobView } from './export-recipe-server';
import {
  readExportQueue,
  saveExportQueue,
  recoverBrowserQueue,
  recipeSummary,
  type RecipeQueueRecord,
} from './export-recipe-store';
import { downloadBlob } from './download-blob';

@Injectable({ providedIn: 'root' })
export class ExportRecipeQueueService {
  private readonly render = inject(ExportRecipeRenderService);
  private readonly server = inject(EXPORT_RECIPE_SERVER, { optional: true });
  readonly serverAvailable = !!this.server;
  readonly record = signal<RecipeQueueRecord | null>(null);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly progress = signal<BatchProgress<string> | null>(null);
  readonly summary = computed(() => {
    const record = this.record();
    return record ? recipeSummary(record) : null;
  });
  readonly remaining = computed(
    () =>
      this.record()?.entries.filter((entry) =>
        ['pending', 'rendering', 'delivering'].includes(entry.status),
      ).length ?? 0,
  );
  private cancelled = false;
  private destroyed = false;
  private readonly ready: Promise<void>;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
    });
    this.ready = readExportQueue()
      .then((record) => {
        this.record.set(record && !record.serverJobId ? recoverBrowserQueue(record) : record);
      })
      .catch((error: unknown) => this.reportError(error));
  }

  async start(assets: readonly Asset[], value: unknown): Promise<void> {
    await this.ready;
    if (this.running()) return;
    if (this.remaining()) {
      this.error.set('Resume or finish the previous export before starting another.');
      return;
    }
    await this.exclusive(async (latest) => {
      if (
        latest?.entries.some((entry) =>
          ['pending', 'rendering', 'delivering'].includes(entry.status),
        )
      )
        throw new Error('Resume the previous export before starting another.');
      const recipe = parseExportRecipe(value);
      const problem = exportRecipeProblem(recipe);
      if (problem) throw new Error(problem);
      if (recipe.destination === 'directory' && !this.server)
        throw new Error(
          'This browser exports to Downloads. Choose Browser downloads, or use a Self Hosted server/CLI for a directory recipe.',
        );
      const targets = await this.render.capture(assets);
      const id = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
      const record: RecipeQueueRecord = {
        id,
        recipe,
        targets,
        entries: targets.map((target) => ({ id: target.id, status: 'pending' })),
        serverJobId: recipe.destination === 'directory' ? id : null,
        cancelled: false,
      };
      await this.execute(record);
    });
  }

  async resume(): Promise<void> {
    await this.ready;
    const saved = this.record();
    if (!saved || this.running()) return;
    await this.exclusive(async (latest) => {
      if (!latest || latest.id !== saved.id)
        throw new Error('The export changed in another tab. Review the current queue.');
      const record = { ...latest, cancelled: false };
      if (!record.serverJobId) {
        await this.runBrowser(record);
        return;
      }
      if (!this.server)
        throw new Error('Reconnect to the Self Hosted workspace that owns this export.');
      // Replaying the same creation request recovers a response lost after durable enqueue.
      await firstValueFrom(this.server.create(record));
      const job = await firstValueFrom(this.server.get(record.serverJobId));
      if (job.status === 'cancelled' || job.status === 'failed')
        await firstValueFrom(this.server.resume(record.serverJobId));
      await this.pollServer(record);
    });
  }

  async retryFailed(): Promise<void> {
    const previous = this.record();
    if (!previous || this.running() || this.remaining()) return;
    const failures = new Set(
      previous.entries.filter((entry) => entry.status === 'failed').map((entry) => entry.id),
    );
    if (!failures.size) return;
    await this.exclusive(async (latest) => {
      if (!latest || JSON.stringify(latest.entries) !== JSON.stringify(previous.entries))
        throw new Error('The export changed in another tab. Review the current queue.');
      if (previous.serverJobId && !this.server)
        throw new Error('Reconnect to the Self Hosted workspace before retrying.');
      const id = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
      const targets = previous.targets.filter((target) => failures.has(target.id));
      const record: RecipeQueueRecord = {
        ...previous,
        id,
        targets,
        entries: targets.map((target) => ({ id: target.id, status: 'pending' })),
        serverJobId: previous.serverJobId ? id : null,
        cancelled: false,
      };
      // Preserve stable sequence indices and the immutable XMP snapshot from the original run.
      await this.execute(record);
    });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    const id = this.record()?.serverJobId;
    if (id && this.server) {
      try {
        await firstValueFrom(this.server.cancel(id));
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private async exclusive(
    work: (latest: RecipeQueueRecord | null) => Promise<void>,
  ): Promise<void> {
    if (this.running()) return;
    this.running.set(true);
    this.error.set(null);
    this.cancelled = false;
    try {
      if (!navigator.locks)
        throw new Error(
          'Persistent export requires browser Web Locks. Use a current browser or the CLI.',
        );
      await navigator.locks.request('maple-export-queue', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('Another tab is exporting. Wait for it to finish.');
        const stored = await readExportQueue();
        const latest = stored && !stored.serverJobId ? recoverBrowserQueue(stored) : stored;
        this.record.set(latest);
        await work(latest);
      });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.running.set(false);
      this.progress.set(null);
    }
  }

  private async execute(record: RecipeQueueRecord): Promise<void> {
    await this.save(record);
    if (record.serverJobId) {
      await firstValueFrom(this.server!.create(record));
      await this.pollServer(record);
    } else await this.runBrowser(record);
  }

  private async runBrowser(record: RecipeQueueRecord): Promise<void> {
    for (const [index, target] of record.targets.entries()) {
      if (this.cancelled || this.destroyed) {
        await this.save({ ...record, cancelled: true });
        return;
      }
      if (record.entries[index].status !== 'pending') continue;
      record.entries[index] = { id: target.id, status: 'rendering' };
      await this.save(record);
      let file;
      let filename;
      try {
        filename = await this.render.filename(target, record.recipe);
        file = await this.render.render(target, record.recipe);
      } catch (error) {
        record.entries[index] = {
          id: target.id,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        };
        await this.save(record);
        this.reportProgress(record, target.id);
        continue;
      }
      // The durable marker precedes the external download handoff. No reload can auto-duplicate it.
      record.entries[index] = { id: target.id, status: 'delivering', filename };
      await this.save(record);
      downloadBlob(file.blob, filename);
      record.entries[index] = { id: target.id, status: 'applied', filename };
      await this.save(record);
      this.reportProgress(record, target.id);
    }
  }

  private async pollServer(record: RecipeQueueRecord): Promise<void> {
    for (;;) {
      if (this.destroyed) return;
      const job = await firstValueFrom(this.server!.get(record.serverJobId!));
      this.applyServerSummary(record, job);
      await this.save(record);
      this.reportProgress(record, '');
      if (job.status !== 'queued' && job.status !== 'running') {
        if (job.error) this.error.set(job.error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private applyServerSummary(record: RecipeQueueRecord, job: ExportJobView): void {
    const summary = job.result ?? job.checkpoint;
    if (!summary) return;
    const applied = new Set(summary.applied);
    const skipped = new Set(summary.skipped ?? []);
    const failures = new Map(summary.failed.map((entry) => [entry.id, entry.reason]));
    record.cancelled = job.status === 'cancelled';
    record.entries = record.targets.map((target) => ({
      id: target.id,
      status: applied.has(target.id)
        ? 'applied'
        : skipped.has(target.id)
          ? 'skipped'
          : failures.has(target.id)
            ? 'failed'
            : 'pending',
      reason: failures.get(target.id),
      filename: summary.outputs?.find((entry) => entry.id === target.id)?.path,
    }));
  }

  private async save(record: RecipeQueueRecord): Promise<void> {
    await saveExportQueue(record);
    this.record.set(structuredClone(record));
  }
  private reportProgress(record: RecipeQueueRecord, id: string): void {
    const summary = recipeSummary(record);
    const processed = record.entries.filter((entry) =>
      ['applied', 'skipped', 'failed'].includes(entry.status),
    ).length;
    this.progress.set({
      current: id,
      outcome:
        record.entries.find((entry) => entry.id === id)?.status === 'failed' ? 'failed' : 'applied',
      total: record.targets.length,
      processed,
      applied: summary.applied.length,
      failed: summary.failed.length,
    });
  }
  private reportError(error: unknown): void {
    this.error.set(
      error instanceof HttpErrorResponse
        ? typeof error.error?.error === 'string'
          ? error.error.error
          : error.message
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}
