// editor-state.service.ts — responsive-program S5c (#625).
//
// Web mirror of Apple's EditorState. Three differences from the Apple
// side, each forced by the platform:
//
//   1. Web has no EditSession analog — adjustment state lives on
//      LibraryStateService keyed by asset id, exposed as a Signal<AdjustmentModel>.
//      So this service owns a snapshot stack of full AdjustmentModel
//      values (cap 32) and applies undo/redo via
//      `LibraryStateService.updateAdjustment(id, snapshot)`.
//   2. Save coalescing piggy-backs on the existing 750ms debounce in
//      `LibraryFetchService.scheduleSidecarWrite` — `updateAdjustment`
//      already schedules it, so live value writes during a drag inherit
//      that.
//   3. `haptic` is a method that fans out via `navigator.vibrate` with
//      feature detection (no `UIImpactFeedbackGenerator` analog).
//
// Spec: docs/design/responsive-program/s5-editor.md §4 + §6.

import { Injectable, computed, inject, signal } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import {
  type ToolGroup,
  type ToolId,
  TOOLS_IN_GROUP,
  defaultDisplayValue,
  displayValueFromInternal,
  fieldFor,
  groupOf,
  isWired,
} from './tool-model';

/** Cap on the editor's undo/redo ring (per spec §4). */
export const UNDO_STACK_CAP = 32;

export type HapticEvent =
  | 'zero-cross' // .light  / vibrate(8)
  | 'extreme' //   .medium / vibrate(12)
  | 'reset' //     .selection / vibrate(4)
  | 'switch'; //   .selection / vibrate(4)

const HAPTIC_DURATION_MS: Record<HapticEvent, number> = {
  'zero-cross': 8,
  extreme: 12,
  reset: 4,
  switch: 4,
};

@Injectable({ providedIn: 'root' })
export class EditorStateService {
  private library = inject(LibraryStateService);

  // ── Identity / arming ────────────────────────────────────────────────────
  readonly imageId = signal<AssetId | null>(null);
  readonly armedGroup = signal<ToolGroup>('light');
  readonly armedTool = signal<ToolId>('exposure');
  readonly fineMode = signal<boolean>(false);

  // ── Snapshot ring (full AdjustmentModel; cap 32) ─────────────────────────
  private readonly _undoStack = signal<AdjustmentModel[]>([]);
  private readonly _redoStack = signal<AdjustmentModel[]>([]);

  readonly canUndo = computed(() => this._undoStack().length > 0);
  readonly canRedo = computed(() => this._redoStack().length > 0);

  // ── Derived: live adjustment + dirty flag ────────────────────────────────
  readonly currentAdjustment = computed<AdjustmentModel | null>(() => {
    const id = this.imageId();
    return id == null ? null : this.library.adjustmentFor(id)();
  });

  /** Internal `[-100, +100]` value for the currently-armed tool. */
  readonly armedInternalValue = computed<number>(() => {
    const adj = this.currentAdjustment();
    const tool = this.armedTool();
    if (!adj) return 0;
    return readToolInternal(adj, tool);
  });

  /** Display-range value (EV / K / unitless ±100). */
  readonly armedDisplayValue = computed<number>(() =>
    displayValueFromInternal(this.armedTool(), this.armedInternalValue()),
  );

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Bind the editor to an asset. Resets undo/redo stacks. */
  bind(id: AssetId, armed?: { group: ToolGroup; tool: ToolId }): void {
    this.imageId.set(id);
    this._undoStack.set([]);
    this._redoStack.set([]);
    if (armed) {
      this.armedGroup.set(armed.group);
      this.armedTool.set(armed.tool);
    }
  }

  /** Snapshot the current model onto the undo stack. Call at the start
   * of a gesture / shortcut so subsequent value writes are reversible. */
  commit(): void {
    const adj = this.currentAdjustment();
    if (!adj) return;
    this._undoStack.update((stack) => {
      const next = [...stack, structuredClone(adj)];
      if (next.length > UNDO_STACK_CAP) next.splice(0, next.length - UNDO_STACK_CAP);
      return next;
    });
    this._redoStack.set([]);
  }

  undo(): void {
    const id = this.imageId();
    if (id == null) return;
    const stack = this._undoStack();
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    const current = this.currentAdjustment();
    if (current) {
      this._redoStack.update((s) => {
        const next = [...s, structuredClone(current)];
        if (next.length > UNDO_STACK_CAP) next.splice(0, next.length - UNDO_STACK_CAP);
        return next;
      });
    }
    this._undoStack.update((s) => s.slice(0, -1));
    this.library.updateAdjustment(id, prev);
  }

  redo(): void {
    const id = this.imageId();
    if (id == null) return;
    const stack = this._redoStack();
    if (stack.length === 0) return;
    const next = stack[stack.length - 1];
    const current = this.currentAdjustment();
    if (current) {
      this._undoStack.update((s) => {
        const arr = [...s, structuredClone(current)];
        if (arr.length > UNDO_STACK_CAP) arr.splice(0, arr.length - UNDO_STACK_CAP);
        return arr;
      });
    }
    this._redoStack.update((s) => s.slice(0, -1));
    this.library.updateAdjustment(id, next);
  }

  // ── Arming ──────────────────────────────────────────────────────────────

  armTool(tool: ToolId): void {
    this.armedTool.set(tool);
    this.armedGroup.set(groupOf(tool));
  }

  armGroup(group: ToolGroup): void {
    this.armedGroup.set(group);
    if (groupOf(this.armedTool()) !== group) {
      this.armedTool.set(TOOLS_IN_GROUP[group][0]);
    }
  }

  // ── Value pipe ──────────────────────────────────────────────────────────

  /** Apply a display-range value to the armed tool (no debounce here;
   * LibraryFetchService.scheduleSidecarWrite is the 750ms coalescer). */
  setArmedDisplayValue(value: number): void {
    const id = this.imageId();
    const tool = this.armedTool();
    if (id == null || !isWired(tool)) return;
    const field = fieldFor(tool);
    if (!field) return;
    this.library.updateAdjustment(id, { [field]: value } as Partial<AdjustmentModel>);
  }

  /** Apply an internal `[-100, +100]` value to the armed tool. */
  setArmedInternalValue(internal: number): void {
    const tool = this.armedTool();
    this.setArmedDisplayValue(displayValueFromInternal(tool, internal));
  }

  /** Reset the armed tool to its canonical default and fire the reset
   *  haptic. The haptic lives here so every reset entry point (drag-bar
   *  double-tap, keyboard `0`) gets consistent feedback. */
  resetArmedTool(): void {
    const tool = this.armedTool();
    if (!isWired(tool)) return;
    this.commit();
    this.setArmedDisplayValue(defaultDisplayValue(tool));
    this.haptic('reset');
  }

  // ── Haptics (web — Vibration API w/ feature detection) ───────────────────

  haptic(event: HapticEvent): void {
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    if (nav && typeof nav.vibrate === 'function') {
      nav.vibrate(HAPTIC_DURATION_MS[event]);
    }
  }
}

function readToolInternal(adj: AdjustmentModel, tool: ToolId): number {
  const field = fieldFor(tool);
  if (!field) return 0;
  const display = adj[field] as number;
  // Inverse of displayValueFromInternal — re-imported via the same module
  // would cycle; inlined here for the (few) cases that matter.
  switch (tool) {
    case 'temp':
      return display >= 6500
        ? ((display - 6500) / (12000 - 6500)) * 100
        : ((display - 6500) / (6500 - 2000)) * 100;
    case 'sharpen':
      return display >= 40 ? ((display - 40) / (150 - 40)) * 100 : ((display - 40) / 40) * 100;
    case 'noise':
    case 'colorNR':
    case 'grain':
      return ((display - 0) / (100 - 0)) * 200 - 100;
    case 'exposure':
      return (display / 4) * 100;
    default:
      return display;
  }
}
