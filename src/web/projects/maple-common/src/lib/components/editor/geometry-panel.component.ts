// GeometryPanelComponent — manual geometry: perspective, rotation, aspect,
// scale and offset (#3410).
//
// Projected into `pro-control-card`'s `cardBodyGeometry` slot whenever the
// Geometry tool is armed, the same shape `lens-corrections-panel`
// (`cardBodyLens`) and `film-panel` (`cardBodyFilm`) take: seven sliders and
// no single primary field, so the drag bar has nothing to drive and this is
// the tool's whole control surface. Apple's `GeometrySection.swift` is the
// structural twin.
//
// Unlike the lens panel's three DECODE-PRODUCT scales, all seven of these are
// display-tail parameters — the WGSL present shader warps by them per tick and
// no decode re-runs — so they write on every tick and preview live, rather than
// parking a value until release. One `EditTransaction` still covers the whole
// gesture: `commit()` on pointer-down opens it and `endGesture()` on release
// closes it, so a drag from 0 to −40 is one undo entry, not forty.
//
// A double-click on a track resets that slider to its own default (the shared
// `mui-living-slider`'s `resetRequest`), which for geometry means the value
// that makes that factor the identity — 100 for Scale, 0 for the other six.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import {
  ADJUSTMENT_RANGES,
  defaultAdjustmentModel,
  type AdjustmentModel,
} from '../../models/adjustment-model';

/** The seven fields, in the order the panel presents them: the keystone pair,
 *  then the shaping trio, then the reframing pair. */
export type GeometryField =
  | 'perspectiveVertical'
  | 'perspectiveHorizontal'
  | 'perspectiveRotate'
  | 'perspectiveScale'
  | 'perspectiveAspect'
  | 'perspectiveX'
  | 'perspectiveY';

/** One slider's presentation, sourced from the generated schema so the bounds
 *  and defaults cannot drift from raw-core. `bipolar` draws the centre notch:
 *  true where the default is the midpoint of a symmetric range, false for
 *  Scale, whose default (100) is the identity rather than a midpoint the user
 *  reads as neutral-either-way. */
export interface GeometrySlider {
  readonly field: GeometryField;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly bipolar: boolean;
  readonly unit: string;
}

const DEFAULTS = defaultAdjustmentModel();

function slider(
  field: GeometryField,
  label: string,
  opts: { step?: number; bipolar?: boolean; unit?: string } = {},
): GeometrySlider {
  const [min, max] = ADJUSTMENT_RANGES[field];
  return {
    field,
    label,
    min,
    max,
    step: opts.step ?? 1,
    bipolar: opts.bipolar ?? true,
    unit: opts.unit ?? '',
  };
}

export const GEOMETRY_SLIDERS: readonly GeometrySlider[] = [
  slider('perspectiveVertical', 'Vertical'),
  slider('perspectiveHorizontal', 'Horizontal'),
  slider('perspectiveRotate', 'Rotate', { step: 0.1, unit: '°' }),
  slider('perspectiveScale', 'Scale', { bipolar: false, unit: '%' }),
  slider('perspectiveAspect', 'Aspect'),
  slider('perspectiveX', 'X Offset'),
  slider('perspectiveY', 'Y Offset'),
];

@Component({
  selector: 'geometry-panel',
  standalone: true,
  imports: [MuiLivingSliderComponent],
  templateUrl: './geometry-panel.component.html',
  host: { class: 'block min-h-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeometryPanelComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editorState = inject(EditorStateService);

  readonly sliders = GEOMETRY_SLIDERS;

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  /** No focused asset means nothing to warp — the sliders show their defaults
   *  and refuse writes rather than silently editing whatever loads next. */
  readonly panelDisabled = computed<boolean>(() => this.library.focusedAssetId() === null);

  valueOf(field: GeometryField): number {
    return this.adj()?.[field] ?? DEFAULTS[field];
  }

  /** Pointer-down / first held arrow key: open the one transaction this whole
   *  gesture will land as. */
  onDragStart(): void {
    if (this.panelDisabled()) return;
    this.editorState.commit();
    this.editorState.beginGesture();
  }

  onDragEnd(): void {
    this.editorState.endGesture();
  }

  onValueChange(field: GeometryField, value: number): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, { [field]: value });
  }

  /** Double-click: back to the value that makes this factor the identity.
   *  A discrete edit, so it opens and closes its own transaction. */
  onReset(field: GeometryField): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.editorState.commit();
    this.library.updateAdjustment(id, { [field]: DEFAULTS[field] });
  }
}
