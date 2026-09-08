// retouch-session.service.ts — the clone / heal editing session (#3409).
//
// Same shape as `MaskSessionService`: `active` derives from the editor's
// armed tool, the selected index is transient UI state, and the spots
// themselves live in `AdjustmentModel.retouchSpots`, so undo/redo, the
// debounced sidecar write and the live render all follow from
// `LibraryStateService.updateAdjustment`.
//
// Two differences from masking, both consequences of repair being a
// DECODE-PRODUCT edit (`stages::retouch`):
//
//  * Every commit is an `EditTransaction` of class `repair`, whose
//    invalidation scope `classifyInvalidation` resolves to `decode` — the
//    canvas re-develops rather than re-running the per-tick chain.
//  * Brush size, feather and opacity are session-level defaults applied to
//    the next spot placed AND written straight through to the selected one,
//    so the panel reads as a brush rather than a per-spot form.

import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import {
  RETOUCH_DEFAULT_FEATHER,
  RETOUCH_DEFAULT_RADIUS,
  isSameRetouchSpot,
  type RetouchKind,
  type RetouchPoint,
  type RetouchSpot,
} from '../../models/retouch-spot';
import { defaultRetouchSource } from './retouch-geometry';
import { removeAt } from '../../editor/list-selection';

@Injectable({ providedIn: 'root' })
export class RetouchSessionService {
  private readonly editor = inject(EditorStateService);
  private readonly library = inject(LibraryStateService);

  /** True while the Heal tool is armed — drives the overlay + panel. */
  readonly active = computed(() => this.editor.armedTool() === 'heal');

  /** Index of the selected spot, or null. Re-validated by `selected`. */
  readonly selectedIndex = signal<number | null>(null);

  /** Brush defaults for the next placement; edits also apply to the selection. */
  readonly brushKind = signal<RetouchKind>('heal');
  readonly brushRadius = signal(RETOUCH_DEFAULT_RADIUS);
  readonly brushFeather = signal(RETOUCH_DEFAULT_FEATHER);
  readonly brushOpacity = signal(1);

  readonly spots = computed<readonly RetouchSpot[]>(() => {
    const a = this.library.focusedAsset();
    return a ? this.library.adjustmentFor(a.id)().retouchSpots : [];
  });

  readonly selected = computed<RetouchSpot | null>(() => {
    const index = this.selectedIndex();
    const spots = this.spots();
    return index !== null && index >= 0 && index < spots.length ? spots[index] : null;
  });

  private gestureOpen = false;

  constructor() {
    effect(() => {
      if (!this.active()) {
        // Disarming mid-drag unmounts the overlay before its pointerup —
        // close the gesture so the next drag opens a fresh undo boundary.
        this.endGesture();
        return;
      }
      if (this.selected() === null && this.spots().length > 0)
        this.selectedIndex.set(this.spots().length - 1);
    });
  }

  select(index: number | null): void {
    this.endGesture();
    const valid = index !== null && index >= 0 && index < this.spots().length;
    this.selectedIndex.set(valid ? index : null);
    const spot = this.selected();
    if (!spot) return;
    // Selecting a spot loads its shape into the brush, so the panel's
    // sliders describe what is on screen rather than a stale default.
    this.brushKind.set(spot.kind);
    this.brushRadius.set(spot.radius);
    this.brushFeather.set(spot.feather);
    this.brushOpacity.set(spot.opacity);
  }

  /** Place a spot centred on `center` with the current brush, select it. */
  place(center: RetouchPoint): number {
    this.endGesture();
    this.commit('Heal');
    const radius = this.brushRadius();
    const spot: RetouchSpot = {
      kind: this.brushKind(),
      center,
      source: defaultRetouchSource(center, radius),
      radius,
      feather: this.brushFeather(),
      opacity: this.brushOpacity(),
    };
    const next = [...this.spots(), spot];
    this.write(next);
    this.selectedIndex.set(next.length - 1);
    return next.length - 1;
  }

  remove(index: number): void {
    const removal = removeAt(this.spots(), index);
    if (!removal) return;
    this.endGesture();
    this.commit('Delete spot');
    this.write(removal.next);
    this.selectedIndex.set(removal.selected);
  }

  /** Drop every spot on the image. */
  resetAll(): void {
    if (this.spots().length === 0) return;
    this.endGesture();
    this.commit('Reset heal');
    this.write([]);
    this.selectedIndex.set(null);
  }

  /** Open a continuous gesture: commits ONE undo snapshot per gesture. */
  beginGesture(): void {
    if (this.gestureOpen) return;
    this.commit('Heal');
    this.gestureOpen = true;
  }

  endGesture(): void {
    this.gestureOpen = false;
  }

  /** Rewrite the selected spot. `discrete` edits commit their own entry;
   *  continuous ones ride the open gesture (opening it if needed). */
  updateSelected(discrete: boolean, transform: (spot: RetouchSpot) => RetouchSpot): void {
    const index = this.selectedIndex();
    const spots = this.spots();
    if (index === null || index < 0 || index >= spots.length) return;
    // Decide whether anything changes BEFORE touching the undo stack, so a
    // redundant write pushes nothing.
    const next = transform(spots[index]);
    if (isSameRetouchSpot(next, spots[index])) return;
    if (discrete) {
      this.endGesture();
      this.commit('Heal');
    } else {
      this.beginGesture();
    }
    this.write(spots.map((spot, i) => (i === index ? next : spot)));
  }

  setShape(spot: RetouchSpot): void {
    this.updateSelected(false, () => spot);
  }

  setKind(kind: RetouchKind): void {
    this.brushKind.set(kind);
    this.updateSelected(true, (spot) => ({ ...spot, kind }));
  }

  setRadius(radius: number): void {
    this.brushRadius.set(radius);
    this.updateSelected(false, (spot) => ({ ...spot, radius }));
  }

  setFeather(feather: number): void {
    this.brushFeather.set(feather);
    this.updateSelected(false, (spot) => ({ ...spot, feather }));
  }

  setOpacity(opacity: number): void {
    this.brushOpacity.set(opacity);
    this.updateSelected(false, (spot) => ({ ...spot, opacity }));
  }

  /** Every repair edit is one `repair`-class transaction (#3409). */
  private commit(description: string): void {
    this.editor.commit('repair', description);
  }

  private write(retouchSpots: RetouchSpot[]): void {
    const a = this.library.focusedAsset();
    if (!a) return;
    this.library.updateAdjustment(a.id, { retouchSpots });
  }
}
