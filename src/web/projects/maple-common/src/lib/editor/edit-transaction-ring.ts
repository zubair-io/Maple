// edit-transaction-ring.ts — the bounded undo / redo ring of committed
// transactions (#2432), split out of `EditorStateService` for the
// file-size budget. Pure bookkeeping: opening, closing, undoing and
// redoing transactions. The side effects of a boundary — handing `after`
// to the library so the sidecar persists it, announcing the change — stay
// in the service, which owns those collaborators. Mirrors Apple's
// `EditTransactionRing` + `EditSession+UndoRedo.swift`.

import { computed, signal } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpSerializerService } from '../xmp/xmp-serializer.service';
import {
  type EditTransaction,
  type EditTransactionKind,
  makeEditTransaction,
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
   * moved the model (it becomes one at the next boundary). */
  canUndo(current: AdjustmentModel | null): boolean {
    if (this._undo().length > 0) return true;
    const pending = this._pending;
    return pending != null && current != null && !sameModel(pending.before, current);
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
   * or `null` when nothing was open or nothing changed. */
  close(serializer: XmpSerializerService, after: AdjustmentModel | null): EditTransaction | null {
    const pending = this._pending;
    this._pending = null;
    if (!pending || !after) return null;
    const tx = makeEditTransaction(serializer, { ...pending, after: structuredClone(after) });
    if (!tx) return null;
    this._undo.update((stack) => pushCapped(stack, tx));
    this.lastCommitted.set(tx);
    return tx;
  }

  /** Abandon the open transaction without recording it. */
  cancel(): void {
    this._pending = null;
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
