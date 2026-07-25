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
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { AssetId } from '../models/asset';
import { type AdjustmentModel, defaultAdjustmentModel } from '../models/adjustment-model';
import { buildApplyPatch, type Preset } from './presets/preset-model';
import {
  type ToolGroup,
  type ToolId,
  TOOLS_IN_GROUP,
  defaultDisplayValue,
  displayRange,
  displayValueFromInternal,
  fieldFor,
  groupOf,
  internalValueFromDisplay,
  isWired,
} from './tool-model';
import {
  type ToolSubParam,
  defaultSubParamId,
  isCommitOnRelease,
  subParamById,
  subParamDefaultDisplay,
  subParamDisplayFromInternal,
  subParamInternalFromDisplay,
  subParamsFor,
} from './tool-sub-param';

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
  private pipeline = inject(RawPipelineService);

  // ── Identity / arming ────────────────────────────────────────────────────
  readonly imageId = signal<AssetId | null>(null);
  readonly armedGroup = signal<ToolGroup>('light');
  readonly armedTool = signal<ToolId>('exposure');
  readonly fineMode = signal<boolean>(false);

  /** Armed sub-param id for multi-param tools (#1108, spec §10.0);
   * `null` while a single-param tool is armed. */
  readonly armedSubParamId = signal<string | null>(defaultSubParamId('exposure'));

  /** Last-armed sub-param per tool, remembered for the SPA session only —
   * never persisted (NOT in XMP, not in `cm.*`). Survives `bind()` so
   * filmstrip image switches keep the selection. */
  private readonly subParamMemory = new Map<ToolId, string>();

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

  /** Ordered sub-params of the armed tool (empty for single-param tools). */
  readonly armedSubParams = computed<readonly ToolSubParam[]>(() => subParamsFor(this.armedTool()));

  /** The armed (tool, subParam) pair's sub-param — `null` while a
   * single-param tool is armed, in which case the tool-level mapping
   * applies unchanged. */
  readonly armedSubParam = computed<ToolSubParam | null>(() => {
    const id = this.armedSubParamId();
    return id == null ? null : subParamById(this.armedTool(), id);
  });

  // ── Commit-on-release buffer (#1153) ─────────────────────────────────────
  //
  // Decode-product sub-params (Noise → Deep / Prefilter) must not write the
  // model per pointer sample: every write re-develops the decode prefix, and
  // BM3D takes seconds. So a gesture over one of them parks its display value
  // here — the drag bar and value chip read it, the pipeline does not — and
  // `endGesture()` performs the single real write on release.

  /** In-flight, uncommitted display value; `null` when nothing is deferred. */
  private readonly _deferredDisplay = signal<number | null>(null);
  /** True between `beginGesture()` and `endGesture()`. */
  private readonly _gestureActive = signal<boolean>(false);

  /** True when writes from the armed pair are held until gesture end. */
  readonly armedCommitsOnRelease = computed<boolean>(() => isCommitOnRelease(this.armedSubParam()));

  /** True while a deferred value is parked and awaiting release. */
  readonly hasDeferredValue = computed<boolean>(() => this._deferredDisplay() !== null);

  /** Internal `[-100, +100]` value for the armed (tool, subParam) pair —
   * the deferred value while one is parked, so the marker tracks the drag
   * even though the model (and therefore the pipeline) has not moved. */
  readonly armedInternalValue = computed<number>(() => {
    const adj = this.currentAdjustment();
    if (!adj) return 0;
    const sub = this.armedSubParam();
    if (!sub) return readToolInternal(adj, this.armedTool());
    const deferred = this._deferredDisplay();
    return subParamInternalFromDisplay(sub, deferred ?? adj[sub.field]);
  });

  /** Display-range value (EV / K / unitless ±100). */
  readonly armedDisplayValue = computed<number>(() => {
    const sub = this.armedSubParam();
    if (sub) return subParamDisplayFromInternal(sub, this.armedInternalValue());
    return displayValueFromInternal(this.armedTool(), this.armedInternalValue());
  });

  /** True when the armed (tool, subParam) pair can take drag-bar /
   * wheel / reset value edits — mirrors Apple's
   * `EditorState.armedToolAcceptsValueEdits`. Sub-params always carry a
   * generated range + field; single-param tools need a wired field and a
   * display range (presets and the #952 stubs fail this). The drag bar
   * gates its pointer-down `commit()` on it so value-less tools can't
   * push junk undo snapshots. */
  readonly armedToolAcceptsValueEdits = computed<boolean>(() => {
    const tool = this.armedTool();
    if (!isWired(tool)) return false;
    if (this.armedSubParam() != null) return true;
    return fieldFor(tool) != null && displayRange(tool) != null;
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Bind the editor to an asset. Resets undo/redo stacks. The armed
   * sub-param is re-resolved from the session memory (it is per-session
   * state, so an image switch keeps the selection). */
  bind(id: AssetId, armed?: { group: ToolGroup; tool: ToolId }): void {
    this.imageId.set(id);
    this._undoStack.set([]);
    this._redoStack.set([]);
    this._discardDeferred();
    if (armed) {
      this.armedGroup.set(armed.group);
      this.armedTool.set(armed.tool);
    }
    this.armedSubParamId.set(this._resolveSubParamId(this.armedTool()));
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
    this._discardDeferred();
    this.armedTool.set(tool);
    this.armedGroup.set(groupOf(tool));
    this.armedSubParamId.set(this._resolveSubParamId(tool));
  }

  armGroup(group: ToolGroup): void {
    this.armedGroup.set(group);
    if (groupOf(this.armedTool()) !== group) {
      this.armTool(TOOLS_IN_GROUP[group][0]);
    }
  }

  /** Arm a sub-param of the armed tool (#1108). No-op for ids the tool
   * doesn't declare (and therefore for single-param tools). Remembered
   * per tool for the session. */
  armSubParam(id: string): void {
    const tool = this.armedTool();
    const sub = subParamById(tool, id);
    if (!sub) return;
    this._discardDeferred();
    this.armedSubParamId.set(sub.id);
    this.subParamMemory.set(tool, sub.id);
  }

  /** Drop any parked commit-on-release value without writing it — the
   * gesture's target is no longer armed (image switch, tool/sub-param
   * switch), so committing would land on the wrong field. */
  private _discardDeferred(): void {
    this._gestureActive.set(false);
    this._deferredDisplay.set(null);
  }

  /** Remembered (session) sub-param for `tool`, falling back to the
   * first-declared; `null` for single-param tools. */
  private _resolveSubParamId(tool: ToolId): string | null {
    const remembered = this.subParamMemory.get(tool);
    if (remembered && subParamById(tool, remembered)) return remembered;
    return defaultSubParamId(tool);
  }

  // ── Value pipe ──────────────────────────────────────────────────────────

  /** Mark the start of a continuous value gesture (drag-bar press, canvas
   * scrub). Only meaningful for commit-on-release sub-params; harmless
   * otherwise. Pairs with `endGesture()`. */
  beginGesture(): void {
    if (this._gestureActive()) return; // idempotent — see Apple's counterpart
    this._deferredDisplay.set(null);
    this._gestureActive.set(true);
  }

  /** Mark the end of a continuous value gesture and flush the parked value,
   * if any, as the single model write of the whole gesture. */
  endGesture(): void {
    const deferred = this._deferredDisplay();
    this._gestureActive.set(false);
    this._deferredDisplay.set(null);
    if (deferred == null) return;
    this.setArmedDisplayValue(deferred);
  }

  /** Abandon a gesture without committing its parked value (pointercancel:
   * stylus lifted, browser-interrupted drag). The already-written per-tick
   * sliders keep their last value, exactly as they did before #1153 — only
   * the deferred write is dropped. */
  cancelGesture(): void {
    this._discardDeferred();
  }

  /** Apply a display-range value to the armed (tool, subParam) pair (no
   * debounce here; LibraryFetchService.scheduleSidecarWrite is the 750ms
   * coalescer). A commit-on-release sub-param under an active gesture parks
   * the value instead — `endGesture()` writes it once. */
  setArmedDisplayValue(value: number): void {
    const id = this.imageId();
    if (id == null || !this.armedToolAcceptsValueEdits()) return;
    if (this._gestureActive() && this.armedCommitsOnRelease()) {
      this._deferredDisplay.set(value);
      return;
    }
    const sub = this.armedSubParam();
    const field = sub ? sub.field : fieldFor(this.armedTool());
    if (!field) return;
    this.library.updateAdjustment(id, { [field]: value } as Partial<AdjustmentModel>);
  }

  /** Apply an internal `[-100, +100]` value to the armed pair. */
  setArmedInternalValue(internal: number): void {
    const sub = this.armedSubParam();
    if (sub) {
      this.setArmedDisplayValue(subParamDisplayFromInternal(sub, internal));
      return;
    }
    this.setArmedDisplayValue(displayValueFromInternal(this.armedTool(), internal));
  }

  /** Reset the armed (tool, subParam) pair to its canonical default and
   *  fire the reset haptic. The haptic lives here so every reset entry
   *  point (drag-bar double-tap, keyboard `0`) gets consistent feedback.
   *  The acceptance guard skips value-less tools (presets, stubs) so
   *  they can't push junk undo entries. For a multi-param tool only the
   *  ARMED sub-param resets — the others keep their values. */
  resetArmedTool(): void {
    if (!this.armedToolAcceptsValueEdits()) return;
    // A reset is an explicit, discrete edit — it always writes through, even
    // for a commit-on-release sub-param, so drop any parked drag value first.
    this._discardDeferred();
    this.commit();
    const sub = this.armedSubParam();
    this.setArmedDisplayValue(
      sub ? subParamDefaultDisplay(sub) : defaultDisplayValue(this.armedTool()),
    );
    this.haptic('reset');
  }

  // ── Presets (#1115, spec §10.7) ──────────────────────────────────────────

  /**
   * Apply a preset: sparse merge of its known fields into the current
   * model as ONE undo-ring entry.
   */
  applyPreset(preset: Preset): boolean {
    const id = this.imageId();
    if (id == null || this.currentAdjustment() == null) return false;
    const patch = buildApplyPatch(preset.fields);
    if (Object.keys(patch).length === 0) return false;
    this.commit();
    this.library.updateAdjustment(id, patch);
    this.haptic('switch');
    return true;
  }

  // ── Reset all (#1372, M1) ─────────────────────────────────────────────────

  /**
   * Reset every develop slider to its factory default, point white balance
   * at the camera's As-Shot reading (falling back to the 6500 K / 0 default
   * when no As-Shot value was captured), and restore the Auto render
   * profile. Crop / rotation is deliberately preserved — RESET only clears
   * develop adjustments, never the user's framing.
   */
  resetAll(): boolean {
    const id = this.imageId();
    if (id == null || this.currentAdjustment() == null) return false;

    const patch: Partial<AdjustmentModel> = { ...defaultAdjustmentModel() };
    delete patch.crop;

    const asShot = this.library.asShotWbFor(id);
    patch.temperature = asShot?.temperature ?? patch.temperature;
    patch.tint = asShot?.tint ?? patch.tint;
    patch.whiteBalancePreset = 'As Shot';
    patch.profile = 'Auto';

    this.commit();
    this.library.updateAdjustment(id, patch);
    this.haptic('reset');
    return true;
  }

  // Snapshot the current adjustment, fetch auto recommendations from the WASM
  // pipeline (via the worker), and apply { exposure, autoExposure: 'Off' } as
  // ONE undo entry. Per live review, AUTO applies EXPOSURE ONLY — the WB
  // estimate produced bad casts and is genuinely hard to guess, so
  // temperature/tint stay at As-Shot. Tone (contrast/highlights/shadows/
  // whites/blacks) is deferred to #1376. The WASM still returns WB + tone; the
  // apply path intentionally ignores them.

  /** True while an AUTO analysis is in flight (disables the AUTO button). */
  readonly autoInFlight = signal<boolean>(false);

  /**
   * Analyse the RAW for `id` and apply auto-adjustment sliders as ONE undo entry.
   */
  async applyAuto(id: AssetId): Promise<boolean> {
    if (this.autoInFlight()) return false;
    if (this.imageId() !== id || this.currentAdjustment() == null) return false;
    this.autoInFlight.set(true);
    try {
      const startId = id;
      let bytes = this.library.bytesFor(id);
      if (!bytes) {
        bytes = await this.library.bytesForAsset(id);
      }
      const asset = this.library.assets().find((a) => a.id === id);
      const ext = asset?.filename.split('.').pop()?.toLowerCase() ?? 'dng';
      const patch = await this.pipeline.computeAutoAdjustments(bytes, ext);
      if (this.imageId() !== startId) return false;
      this.commit();
      // Apply EXPOSURE ONLY (+ the AE-Off mode). White balance and tone are
      // intentionally NOT written — WB stays at As-Shot, tone deferred to #1376.
      this.library.updateAdjustment(id, {
        exposure: patch.exposure,
        autoExposure: 'Off',
      });
      return true;
    } catch (err) {
      console.error('[EditorStateService] applyAuto failed:', err);
      return false;
    } finally {
      this.autoInFlight.set(false);
    }
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
  return internalValueFromDisplay(tool, adj[field] as number);
}
