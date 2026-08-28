// MuiCropToolbar — Maple UI design-system Crop Toolbar organism
// (unified-component-catalog.md §4.5). Built from: Chip Row, Drag Bar,
// Button. Aspect-ratio presets (Chip Row, `select` mode) plus a straighten
// angle scrub (Drag Bar) and a Reset button that restores both to their
// defaults.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiDragBarComponent } from '../drag-bar/mui-drag-bar.component';
import { MuiButtonComponent } from '../button/mui-button.component';

/** Default four-preset showcase set — a caller with a real preset list
 * (e.g. the Pro Editor's nine Apple-parity aspects, #3046) passes its own
 * via the `aspectChips` input instead. */
const DEFAULT_ASPECT_CHIPS: readonly MuiChip[] = [
  { id: 'free', label: 'Free' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
  { id: '16:9', label: '16:9' },
];

const DEFAULT_ASPECT = 'free';
const DEFAULT_ANGLE = 0;

@Component({
  selector: 'mui-crop-toolbar',
  standalone: true,
  imports: [MuiChipRowComponent, MuiDragBarComponent, MuiButtonComponent],
  templateUrl: './mui-crop-toolbar.component.html',
  styleUrl: './mui-crop-toolbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCropToolbarComponent {
  /** Aspect preset id — the chip ids ARE the aspect values (`'free'`,
   * `'1:1'`, `'4:5'`, `'16:9'`), kept as a plain `string` model so a caller
   * can pass any preset set without a closed union. */
  readonly aspect = model<string>(DEFAULT_ASPECT);
  readonly angle = model<number>(DEFAULT_ANGLE);

  /** Discrete change events alongside the `model()`s above, for callers
   * that prefer an explicit event over reading the two-way-bound value. */
  readonly aspectChanged = output<string>();
  readonly angleChanged = output<number>();
  readonly resetRequested = output<void>();

  /** The aspect-ratio preset chips (id/label/disabled/testId) — configurable
   * so a caller with a real preset list isn't stuck with the four-item
   * showcase default. */
  readonly aspectChips = input<readonly MuiChip[]>(DEFAULT_ASPECT_CHIPS);
  /** Forwarded to the straighten drag-bar's own `testId` — lets a caller's
   * integration test drive the real interactive track directly. */
  readonly straightenTestId = input<string | null>(null);
  /** Forwarded to the Reset button's own `testId`. */
  readonly resetTestId = input<string | null>(null);
  /** A caller with its own "is there anything to reset" predicate (e.g.
   * the Pro Editor only enables Reset for a non-identity crop, not merely
   * a non-default chip selection) overrides the button's disabled state. */
  readonly resetDisabled = input<boolean>(false);

  /** Forwarded from the straighten drag-bar's own gesture-boundary
   * outputs — a caller that needs to snapshot undo state at the start of
   * a straighten drag (the Pro Editor's `onStraightenStart`) has no other
   * way to observe that moment. */
  readonly straightenDragStart = output<void>();
  readonly straightenDragEnd = output<void>();

  onAspectChange(id: string | null): void {
    const next = id ?? DEFAULT_ASPECT;
    this.aspect.set(next);
    this.aspectChanged.emit(next);
  }

  onAngleChange(next: number): void {
    this.angle.set(next);
    this.angleChanged.emit(next);
  }

  onReset(): void {
    this.aspect.set(DEFAULT_ASPECT);
    this.angle.set(DEFAULT_ANGLE);
    this.aspectChanged.emit(DEFAULT_ASPECT);
    this.angleChanged.emit(DEFAULT_ANGLE);
    this.resetRequested.emit();
  }
}
