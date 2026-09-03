// mask-session.service.ts — the mask-editing session (#1541).
//
// `active` is derived from the editor's armed tool, so the overlay shows and
// the panel swaps in exactly while the Mask dock entry is armed — the same
// derivation `CropSessionService` uses. The selected-layer index is transient
// UI state (never persisted); the layers themselves are
// `AdjustmentModel.localAdjustments`, so undo/redo, the debounced sidecar
// write and the live render all follow from `LibraryStateService.
// updateAdjustment` — one source of truth, the same rule every other tool
// obeys. The render needs no host change: the canvas hands raw-core the
// serialized sidecar, which now carries the containers (#358), and the
// 19-scalar fast path already routes a non-empty stack to the full path.
//
// Undo boundaries: a DISCRETE edit (add, remove, invert, reset) commits its
// own snapshot; a CONTINUOUS one (a slider or a canvas-handle drag) opens a
// gesture with `beginGesture()` — which commits once, idempotently — and
// closes it with `endGesture()` on release, mirroring the Apple
// `EditorState+Masks` API.

import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import type { LocalAdjustment, LocalMask, PartialAdjustments } from '../../models/local-adjustment';
import { defaultLinearMask, defaultRadialMask, withMaskFeather } from './mask-geometry';

/** Structural equality for one layer — the model is plain data. */
const isSameLayer = (a: LocalAdjustment, b: LocalAdjustment): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

@Injectable({ providedIn: 'root' })
export class MaskSessionService {
  private readonly editor = inject(EditorStateService);
  private readonly library = inject(LibraryStateService);

  /** True while the Mask tool is armed — drives the overlay + panel. */
  readonly active = computed(() => this.editor.armedTool() === 'mask');

  /** Index of the selected layer, or null. Re-validated by `selected`. */
  readonly selectedIndex = signal<number | null>(null);

  readonly layers = computed<readonly LocalAdjustment[]>(() => {
    const a = this.library.focusedAsset();
    return a ? this.library.adjustmentFor(a.id)().localAdjustments : [];
  });

  readonly selected = computed<LocalAdjustment | null>(() => {
    const index = this.selectedIndex();
    const layers = this.layers();
    return index !== null && index >= 0 && index < layers.length ? layers[index] : null;
  });

  private gestureOpen = false;

  constructor() {
    // Arming the tool with nothing valid selected lands on the first layer,
    // so the panel never opens on "nothing" when layers exist.
    effect(() => {
      if (!this.active()) {
        // Disarming mid-drag unmounts the overlay before its pointerup —
        // close the gesture so the next drag opens a fresh undo boundary.
        this.endGesture();
        return;
      }
      if (this.selected() === null && this.layers().length > 0) this.selectedIndex.set(0);
    });
  }

  select(index: number | null): void {
    this.endGesture();
    const valid = index !== null && index >= 0 && index < this.layers().length;
    this.selectedIndex.set(valid ? index : null);
  }

  /** Append a layer carrying `mask` and no adjustments, select it, return its index. */
  add(mask: LocalMask): number {
    this.endGesture();
    this.editor.commit();
    const next = [...this.layers(), { mask, adjustments: {} }];
    this.write(next);
    this.selectedIndex.set(next.length - 1);
    return next.length - 1;
  }

  addLinear(): number {
    return this.add(defaultLinearMask());
  }

  addRadial(): number {
    const a = this.library.focusedAsset();
    const aspect = a?.width && a?.height ? a.width / a.height : 1;
    return this.add(defaultRadialMask(aspect));
  }

  remove(index: number): void {
    const layers = this.layers();
    if (index < 0 || index >= layers.length) return;
    this.endGesture();
    this.editor.commit();
    const next = layers.filter((_, i) => i !== index);
    this.write(next);
    this.selectedIndex.set(next.length === 0 ? null : Math.min(index, next.length - 1));
  }

  removeSelected(): void {
    const index = this.selectedIndex();
    if (index !== null) this.remove(index);
  }

  /** Open a continuous gesture: commits ONE undo snapshot per gesture. */
  beginGesture(): void {
    if (this.gestureOpen) return;
    this.editor.commit();
    this.gestureOpen = true;
  }

  endGesture(): void {
    this.gestureOpen = false;
  }

  /** Rewrite the selected layer. `discrete` edits commit their own entry;
   *  continuous ones ride the open gesture (opening it if needed). */
  updateSelected(discrete: boolean, transform: (layer: LocalAdjustment) => LocalAdjustment): void {
    const index = this.selectedIndex();
    const layers = this.layers();
    if (index === null || index < 0 || index >= layers.length) return;
    // Decide whether anything changes BEFORE touching the undo stack, so a
    // no-op (invert on a linear layer, a redundant write) pushes nothing.
    const next = transform(layers[index]);
    if (next === layers[index] || isSameLayer(next, layers[index])) return;
    if (discrete) {
      this.endGesture();
      this.editor.commit();
    } else {
      this.beginGesture();
    }
    this.write(layers.map((layer, i) => (i === index ? next : layer)));
  }

  setShape(mask: LocalMask): void {
    this.updateSelected(false, (layer) => ({ ...layer, mask }));
  }

  /** The selected layer's value for `field`, `0` when unset. */
  adjustment(field: keyof PartialAdjustments): number {
    return this.selected()?.adjustments[field] ?? 0;
  }

  setAdjustment(field: keyof PartialAdjustments, value: number): void {
    this.updateSelected(false, (layer) => ({
      ...layer,
      adjustments: { ...layer.adjustments, [field]: value },
    }));
  }

  resetAdjustments(): void {
    this.updateSelected(true, (layer) => ({ ...layer, adjustments: {} }));
  }

  setFeather(feather: number): void {
    this.updateSelected(false, (layer) => ({
      ...layer,
      mask: withMaskFeather(layer.mask, feather),
    }));
  }

  /** Flip a radial layer's sense; no-op for a linear layer. */
  setInverted(invert: boolean): void {
    this.updateSelected(true, (layer) =>
      layer.mask.kind === 'radial' ? { ...layer, mask: { ...layer.mask, invert } } : layer,
    );
  }

  private write(localAdjustments: LocalAdjustment[]): void {
    const a = this.library.focusedAsset();
    if (!a) return;
    this.library.updateAdjustment(a.id, { localAdjustments });
  }
}
