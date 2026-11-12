// edit-transaction-ring.ts — the bounded undo / redo ring of committed
// transactions (#2432), split out of `EditorStateService` for the
// file-size budget. Pure bookkeeping: opening, closing, undoing and
// redoing transactions. The side effects of a boundary — handing `after`
// to the library so the sidecar persists it, announcing the change — stay
// in the service, which owns those collaborators. Mirrors Apple's
// `EditTransactionRing` + `EditSession+UndoRedo.swift`.

import { computed, signal } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import { alignImportedAuto } from '../models/partial-white-balance';
import type { XmpSerializerService } from '../xmp/xmp-serializer.service';
import type { RingStep } from './editor-workflow-ring';
import {
  type EditTransaction,
  type EditTransactionKind,
  makeEditTransaction,
  sidecarDiff,
  classifyInvalidation,
  stableStringify,
} from './edit-transaction';

/** Cap on the editor's undo/redo ring (per spec §4). */
export const UNDO_STACK_CAP = 32;

/** An open, not-yet-recorded transaction. */
interface PendingEdit {
  readonly id: number;
  readonly kind: EditTransactionKind;
  readonly description: string;
  readonly before: AdjustmentModel;
}

export class EditTransactionRing {
  private readonly _undo = signal<EditTransaction[]>([]);
  private readonly _redo = signal<EditTransaction[]>([]);
  private _pending: PendingEdit | null = null;
  private _nextId = 0;

  /** The most recently recorded, undone, or redone transaction. */
  readonly lastCommitted = signal<EditTransaction | null>(null);

  readonly canRedo = computed(() => this._redo().length > 0);

  /** True when an undo entry exists OR the open transaction has already
   * moved the model (it becomes one at the next boundary). An imported Auto
   * estimate landing mid-transaction is not a move (#4669). */
  canUndo(current: AdjustmentModel | null): boolean {
    if (this._undo().length > 0) return true;
    const pending = this._pending;
    if (pending == null || current == null) return false;
    return !sameModel(alignImportedAuto(pending.before, current), current);
  }

  /** The recorded transactions, oldest first. */
  history(): readonly EditTransaction[] {
    return this._undo();
  }

  /** Forget everything (asset switch); ids restart at 1 for the new binding. */
  reset(): void {
    this._pending = null;
    this._nextId = 0;
    this._undo.set([]);
    this._redo.set([]);
    this.lastCommitted.set(null);
  }

  /** Open a transaction; the caller closes any previous one first. */
  open(kind: EditTransactionKind, description: string, before: AdjustmentModel): void {
    this._nextId += 1;
    this._pending = { id: this._nextId, kind, description, before: structuredClone(before) };
    this._redo.set([]);
  }

  /** Close the open transaction against `after`. Records and returns it,
   * or `null` when nothing was open or nothing changed. The background
   * imported Auto resolution is not the user's change, so `before` takes it too. */
  close(serializer: XmpSerializerService, after: AdjustmentModel | null): EditTransaction | null {
    const pending = this._pending;
    this._pending = null;
    if (!pending || !after) return null;
    const before = alignImportedAuto(pending.before, after);
    const tx = makeEditTransaction(serializer, {
      ...pending,
      before,
      after: structuredClone(after),
    });
    if (!tx) return null;
    this._undo.update((stack) => pushCapped(stack, tx));
    this.lastCommitted.set(tx);
    return tx;
  }

  /** Abandon the open transaction without recording it. */
  cancel(): void {
    this._pending = null;
  }

  recordCheckpoint(
    serializer: XmpSerializerService,
    before: AdjustmentModel,
    after: AdjustmentModel,
    checkpoint: NonNullable<EditTransaction['checkpoint']>,
    description: string,
  ): EditTransaction | null {
    if (checkpoint.before === checkpoint.after) return null;
    const tx = this.checkpointTransaction(serializer, before, after, checkpoint, description);
    this._undo.update((stack) => pushCapped(stack, tx));
    this._redo.set([]);
    this.lastCommitted.set(tx);
    return tx;
  }

  /** Nothing recorded, open, or redoable since the bind. */
  untouched(): boolean {
    return !this._pending && this._undo().length === 0 && this._redo().length === 0;
  }

  /** Rebuild Undo/Redo from the persisted history of a reopened sidecar (#4983).
   * An untouched ring only: anything recorded or open since the bind is newer. */
  seed(
    serializer: XmpSerializerService,
    undo: readonly RingStep[],
    redo: readonly RingStep[],
  ): boolean {
    if (!this.untouched()) return false;
    const build = (step: RingStep) =>
      this.checkpointTransaction(
        serializer,
        step.before,
        step.after,
        step.checkpoint,
        step.description,
      );
    this._undo.set(undo.map(build).slice(-UNDO_STACK_CAP));
    this._redo.set(redo.map(build).reverse().slice(-UNDO_STACK_CAP));
    return true;
  }

  private checkpointTransaction(
    serializer: XmpSerializerService,
    before: AdjustmentModel,
    after: AdjustmentModel,
    checkpoint: NonNullable<EditTransaction['checkpoint']>,
    description: string,
  ): EditTransaction {
    this._nextId += 1;
    return {
      id: this._nextId,
      kind: 'variant',
      description,
      before: structuredClone(before),
      after: structuredClone(after),
      checkpoint,
      diff: sidecarDiff(serializer, before, after),
      invalidation: classifyInvalidation(before, after),
    };
  }

  peek(direction: 'undo' | 'redo'): EditTransaction | null {
    const stack = direction === 'undo' ? this._undo() : this._redo();
    return stack.at(-1) ?? null;
  }

  /** Move the newest undo entry to the redo side and return it. */
  popUndo(): EditTransaction | null {
    const stack = this._undo();
    if (stack.length === 0) return null;
    const tx = stack[stack.length - 1];
    this._undo.update((s) => s.slice(0, -1));
    this._redo.update((s) => pushCapped(s, tx));
    this.lastCommitted.set(tx);
    return tx;
  }

  /** Move the newest redo entry back to the undo side and return it. */
  popRedo(): EditTransaction | null {
    const stack = this._redo();
    if (stack.length === 0) return null;
    const tx = stack[stack.length - 1];
    this._redo.update((s) => s.slice(0, -1));
    this._undo.update((s) => pushCapped(s, tx));
    this.lastCommitted.set(tx);
    return tx;
  }
}

function pushCapped(stack: EditTransaction[], tx: EditTransaction): EditTransaction[] {
  const next = [...stack, tx];
  return next.length > UNDO_STACK_CAP ? next.slice(next.length - UNDO_STACK_CAP) : next;
}

function sameModel(a: AdjustmentModel, b: AdjustmentModel): boolean {
  return stableStringify(a) === stableStringify(b);
}
