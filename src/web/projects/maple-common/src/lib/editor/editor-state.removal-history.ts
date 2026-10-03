// Confirmed accepted-pixel history (#3984). Models and the editor ring move
// only after verified companions and a source-bound XMP CAS have succeeded.
import { Injector, inject } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import { XmpStoreService } from '../xmp/xmp-store.service';
import type { EditorStateService } from './editor-state.service';
import { stableStringify, type EditTransactionKind } from './edit-transaction';

export class EditorRemovalHistory {
  private readonly sidecars = inject(XmpStoreService);
  private readonly injector = inject(Injector);
  private pending?: Promise<string>;

  constructor(private readonly editor: EditorStateService) {}

  accept(
    target: AdjustmentModel,
    expected: AdjustmentModel,
    description: string,
    sidecarRevision?: string,
    kind: EditTransactionKind = 'repair',
  ): Promise<string> {
    return this.save(
      target,
      expected,
      () => this.editor.recordConfirmedRemoval(expected, target, description, kind),
      sidecarRevision,
    );
  }

  restore(target: AdjustmentModel, expected: AdjustmentModel, confirmed: () => void): void {
    void this.save(target, expected, confirmed).catch(() => undefined);
  }

  async settled(): Promise<void> {
    await this.pending;
  }

  private save(
    target: AdjustmentModel,
    expected: AdjustmentModel,
    confirmed: () => void,
    sidecarRevision?: string,
  ): Promise<string> {
    const editor = this.editor;
    if (editor.removalSaving() || editor.workflowBusy())
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
    const binding = editor.bindingRevision;
    editor.removalSaving.set(true);
    editor.removalSaveError.set(null);
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
          : await this.sidecars.writeRemovalConfirmed(
              id,
              folder!,
              asset.filename,
              target,
              culling,
              expected.inpaintRemovals ?? '[]',
              target.inpaintRemovals ?? '[]',
              sidecarRevision ??
                (await this.sidecars.captureRemovalRevision(id, folder!, asset.filename)),
            );
        // Persistence is authoritative even if navigation retired this ring.
        editor.library.adoptConfirmedRemoval(id, target);
        if (editor.bindingRevision === binding) confirmed();
        return revision;
      } catch (error) {
        if (editor.bindingRevision === binding)
          editor.removalSaveError.set(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        editor.library.removalSavingAsset.set(null);
        editor.removalSaving.set(false);
      }
    })();
    this.pending = task;
    return task;
  }

  private reject(message: string): Promise<string> {
    this.editor.removalSaveError.set(message);
    const task = Promise.reject<string>(new Error(message));
    this.pending = task;
    return task;
  }
}

export function undoEditor(editor: EditorStateService): void {
  if (editor.removalSaving() || editor.workflowBusy()) return;
  const id = editor.imageId();
  if (id == null) return;
  editor.endEdit();
  const tx = editor.ring.peekUndo();
  if (!tx) return;
  if (tx.before.inpaintRemovals !== tx.after.inpaintRemovals) {
    editor.acceptedHistory().restore(tx.before, tx.after, () => {
      editor.ring.popUndo();
      void editor.announcer.announce(`Undo ${tx.description}`);
    });
    return;
  }
  editor.ring.popUndo();
  editor.library.updateAdjustment(id, structuredClone(tx.before));
  void editor.announcer.announce(`Undo ${tx.description}`);
}

export function redoEditor(editor: EditorStateService): void {
  if (editor.removalSaving() || editor.workflowBusy()) return;
  const id = editor.imageId();
  if (id == null) return;
  editor.endEdit();
  const tx = editor.ring.peekRedo();
  if (!tx) return;
  if (tx.before.inpaintRemovals !== tx.after.inpaintRemovals) {
    editor.acceptedHistory().restore(tx.after, tx.before, () => {
      editor.ring.popRedo();
      void editor.announcer.announce(`Redo ${tx.description}`);
    });
    return;
  }
  editor.ring.popRedo();
  editor.library.updateAdjustment(id, structuredClone(tx.after));
  void editor.announcer.announce(`Redo ${tx.description}`);
}
