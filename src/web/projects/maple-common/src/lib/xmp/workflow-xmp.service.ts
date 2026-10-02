/** Shared Rust metadata conversion at the confirmed-save boundary (#4036). */
import { DestroyRef, Injectable, inject } from '@angular/core';
import {
  parseSidecarWorkflow,
  type SidecarWorkflow,
  type WorkflowHistoryEntry,
  type WorkflowSnapshot,
} from '../generated/workflow.generated';

@Injectable({ providedIn: 'root' })
export class WorkflowXmpService {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >();
  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }

  async read(xmp: string): Promise<SidecarWorkflow | null> {
    const value: unknown = JSON.parse(await this.convert('read', xmp));
    return value === null ? null : parseSidecarWorkflow(value);
  }
  embed(workflow: SidecarWorkflow, xmp: string): Promise<string> {
    return this.convert('embed', xmp, JSON.stringify(parseSidecarWorkflow(workflow)));
  }
  commit(entry: WorkflowHistoryEntry, xmp: string): Promise<string> {
    return this.convert('commit', xmp, JSON.stringify(entry));
  }
  snapshot(snapshot: WorkflowSnapshot, xmp: string): Promise<string> {
    return this.convert('snapshot', xmp, JSON.stringify(snapshot));
  }
  restore(entry: WorkflowHistoryEntry, xmp: string): Promise<string> {
    return this.convert('restore', xmp, JSON.stringify(entry));
  }
  checkpoint(xmp: string): Promise<string> {
    return this.convert('checkpoint', xmp);
  }
  variantFilename(primaryName: string, variantId: string): Promise<string> {
    return this.convert('filename', primaryName, variantId);
  }
  private convert(
    operation: 'read' | 'embed' | 'checkpoint' | 'filename' | 'commit' | 'snapshot' | 'restore',
    xmp: string,
    json?: string,
  ): Promise<string> {
    if (!this.worker) this.open();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker!.postMessage({ id, operation, xmp, json });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private open(): void {
    const worker = new Worker(new URL('./workflow-xmp.worker', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<{ id: number; value?: string; error?: string }>) => {
      const pending = this.pending.get(event.data.id);
      this.pending.delete(event.data.id);
      if (!pending) return;
      if (event.data.value !== undefined) pending.resolve(event.data.value);
      else pending.reject(new Error(event.data.error ?? 'Workflow conversion failed'));
    };
    worker.onerror = () => this.close();
    worker.onmessageerror = () => this.close();
    this.worker = worker;
  }
  private close(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values())
      pending.reject(new Error('Workflow worker unavailable. Retry the save.'));
    this.pending.clear();
  }
}
