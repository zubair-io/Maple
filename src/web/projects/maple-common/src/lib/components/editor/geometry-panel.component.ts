import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { ADJUSTMENT_RANGES } from '../../models/adjustment-model';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';

type GeometryField =
  | 'geoPerspectiveH'
  | 'geoPerspectiveV'
  | 'geoRotation'
  | 'geoAspect'
  | 'geoScale';

@Component({
  selector: 'geometry-panel',
  standalone: true,
  imports: [MuiLivingSliderComponent],
  templateUrl: './geometry-panel.component.html',
  styleUrl: './geometry-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeometryPanelComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  readonly adjustment = computed(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });
  readonly controls: ReadonlyArray<{
    field: GeometryField;
    label: string;
    identity: number;
    step: number;
  }> = [
    { field: 'geoPerspectiveH', label: 'Horizontal perspective', identity: 0, step: 0.005 },
    { field: 'geoPerspectiveV', label: 'Vertical perspective', identity: 0, step: 0.005 },
    { field: 'geoRotation', label: 'Rotation', identity: 0, step: 0.1 },
    { field: 'geoAspect', label: 'Aspect', identity: 1, step: 0.01 },
    { field: 'geoScale', label: 'Scale', identity: 1, step: 0.01 },
  ];
  readonly ranges = ADJUSTMENT_RANGES;

  begin(): void {
    this.editor.commit();
  }

  change(field: GeometryField, value: number): void {
    const id = this.library.focusedAssetId();
    if (!id || !Number.isFinite(value)) return;
    const [min, max] = this.ranges[field];
    this.library.updateAdjustment(id, { [field]: Math.max(min, Math.min(max, value)) });
  }

  reset(field: GeometryField, value: number): void {
    this.begin();
    this.change(field, value);
  }
}
