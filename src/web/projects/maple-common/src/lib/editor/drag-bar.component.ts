// drag-bar.component.ts — responsive-program S5b (#625).
//
// 21-tick scrub bar. Long-press the marker → fine mode for the next drag.
// Double-tap to reset to 0. Haptics via EditorStateService.haptic().
//
// Spec: docs/design/responsive-program/s5-editor.md §3.
//
// Chrome + gesture math now delegate to `mui-drag-bar`'s `dragMode:
// 'relative'` (#3046) — the same touch-down-never-jumps / long-press-fine
// / haptics-hook contract this component used to own via
// `drag-bar-math.ts`. This wrapper's own job is: translate the armed
// (tool, subParam) pair's internal value in and out of
// `EditorStateService`, and wire the gesture-boundary/haptics-hook outputs
// back onto the service calls that used to live inline in
// `onPointerDown`/`onPointerMove`/`onPointerUp`.

import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { MuiDragBarComponent } from '../ui/drag-bar/mui-drag-bar.component';
import { EditorStateService } from './editor-state.service';

const VALUE_MIN = -100;
const VALUE_MAX = 100;

@Component({
  selector: 'app-drag-bar',
  standalone: true,
  imports: [MuiDragBarComponent],
  templateUrl: './drag-bar.component.html',
  host: { class: 'block h-[30px] px-6 [touch-action:none]' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DragBarComponent {
  readonly state = inject(EditorStateService);

  readonly valueMin = VALUE_MIN;
  readonly valueMax = VALUE_MAX;

  /** Internal value the marker reflects — the service derives it from
   *  the armed (tool, subParam) pair (#1108), so the marker tracks the
   *  armed sub-param's mapping on multi-param tools. */
  readonly internalValue = computed(() => this.state.armedInternalValue());

  readonly ariaLabel = computed(() => `Drag bar marker, value ${this.state.armedDisplayValue()}`);

  onValueChange(v: number): void {
    this.state.setArmedInternalValue(v);
  }

  onDragStart(): void {
    this.state.commit();
    // Commit-on-release sub-params (Noise → Deep / Prefilter, #1153) park
    // their value for the gesture instead of re-developing per pointer move;
    // for every other tool this is inert.
    this.state.beginGesture();
  }

  onDragEnd(): void {
    this.state.fineMode.set(false);
    // Release is the commit point for deferred (decode-product) sub-params.
    this.state.endGesture();
  }

  onFineModeEngaged(): void {
    this.state.fineMode.set(true);
    this.state.haptic('switch');
  }

  onCrossedZero(): void {
    this.state.haptic('zero-cross');
  }

  onReachedExtreme(): void {
    this.state.haptic('extreme');
  }

  @HostListener('dblclick')
  onDoubleClick(): void {
    // Route through resetArmedTool so each tool snaps to its canonical
    // default (e.g. Color NR → 25, Sharpen → 40, Temp → 6500), not the
    // internal-zero point that drifts off-default for one-sided tools.
    this.state.resetArmedTool();
  }
}
