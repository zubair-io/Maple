// Confirmed accepted-pixel history (#3984). Models and the editor ring move
// only after verified companions and a source-bound XMP CAS have succeeded.
import { Injector, inject, signal } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import { XmpRemovalWritesService } from '../xmp/xmp-store.writes';
import type { EditorStateService } from './editor-state.service';
import { stableStringify, type EditTransactionKind } from './edit-transaction';

export class EditorRemovalHistory {
  private readonly injector = inject(Injector);
  private pending?: Promise<string>;
  private bindingRevision = 0;
  readonly saveError = signal<string | null>(null);

  constructor(private readonly editor: EditorStateService) {}

  rebind(): void {
    this.bindingRevision += 1;
    this.saveError.set(null);
  }

  acceptRecords(
    records: string,
    expected: AdjustmentModel,
    description: string,
    sidecarRevision: string,
  ): Promise<string> {
    const inpaintRemovals = records === '[]' ? undefined : records;
    return this.accept({ ...expected, inpaintRemovals }, expected, description, sidecarRevision);
  }

  accept(
    target: AdjustmentModel,
    expected: AdjustmentModel,
    description: string,
    sidecarRevision?: string,
    kind: EditTransactionKind = 'repair',
  ): Promise<string> {
    const record = () => {
      const { ring, serializer, announcer } = this.editor;
      const tx = ring.recordConfirmed(serializer, expected, target, description, kind);
      if (tx) void announcer.announce(description);
    };
    return this.save(target, expected, record, sidecarRevision);
  }

  resetAll(patch: Partial<AdjustmentModel>): boolean {
    const current = this.editor.currentAdjustment();
    if (!current) return false;
    const target = { ...current, ...patch };
    void this.accept(target, current, 'Reset all adjustments', undefined, 'reset').catch(
      () => undefined,
    );
    return true;
  }

  /** Routes an undo/redo step that changes accepted removals through a confirmed save. */
  takes(direction: 'undo' | 'redo'): boolean {
    const ring = this.editor.ring;
    const tx = ring.peek(direction);
    if (!tx || tx.before.inpaintRemovals === tx.after.inpaintRemovals) return false;
    const undo = direction === 'undo';
    const confirmed = () => {
      if (undo) ring.popUndo();
      else ring.popRedo();
      void this.editor.announcer.announce(`${undo ? 'Undo' : 'Redo'} ${tx.description}`);
    };
    const [target, expected] = undo ? [tx.before, tx.after] : [tx.after, tx.before];
    void this.save(target, expected, confirmed).catch(() => undefined);
    return true;
  }

  async settled(): Promise<void> {
    await this.pending;
  }

  private sidecars(): XmpRemovalWritesService {
    return this.injector.get(XmpRemovalWritesService);
  }

  private save(
    target: AdjustmentModel,
    expected: AdjustmentModel,
    confirmed: () => void,
    sidecarRevision?: string,
  ): Promise<string> {
    const editor = this.editor;
    if (editor.workflowBusy())
      return Promise.reject(new Error('An editor save is already running.'));
    const id = editor.imageId();
    const asset = editor.library.focusedAsset();
    const folder = editor.library.currentFolder();
    const server = editor.library.backend === 'self-hosted';
    if (!id || asset?.id !== id || (!server && (!folder?.native || !folder.write)))
      return this.reject('Removal history requires this photo’s writable folder.');
    if (stableStringify(editor.currentAdjustment()) !== stableStringify(expected))
      return this.reject('The photo changed before this removal could be saved.');
    editor.endEdit();
    const binding = this.bindingRevision;
    editor.workflowBusy.set(true);
    this.saveError.set(null);
    editor.library.removalSavingAsset.set(id);
    const task = (async () => {
      try {
        const culling = editor.library.assets().find((item) => item.id === id) ?? asset;
        const revision = server
          ? await import('../removal/server-removal-sidecars').then(({ ServerRemovalSidecars }) =>
              new ServerRemovalSidecars(editor.library, this.injector).write(
                id,
                target,
                culling,
                expected.inpaintRemovals ?? '[]',
                target.inpaintRemovals ?? '[]',
                sidecarRevision,
              ),
            )
          : await this.sidecars().writeRemovalConfirmed(
              id,
              folder!,
              asset.filename,
              target,
              culling,
              expected.inpaintRemovals ?? '[]',
              target.inpaintRemovals ?? '[]',
              sidecarRevision ??
                (await this.sidecars().captureRemovalRevision(id, folder!, asset.filename)),
            );
        // Persistence is authoritative even if navigation retired this ring.
        editor.library.adoptConfirmedRemoval(id, target);
        if (this.bindingRevision === binding) confirmed();
        return revision;
      } catch (error) {
        if (this.bindingRevision === binding)
          this.saveError.set(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        editor.library.removalSavingAsset.set(null);
        editor.workflowBusy.set(false);
      }
    })();
    this.pending = task;
    return task;
  }

  private reject(message: string): Promise<string> {
    this.saveError.set(message);
    const task = Promise.reject<string>(new Error(message));
    this.pending = task;
    return task;
  }
}
