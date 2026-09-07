// DemosaicPanelComponent — the Bayer demosaic kernel picker (#3413).
//
// Projected into `pro-control-card`'s `cardBodyDemosaic` slot, which the
// card renders at the top of the Detail group's *Basic* body — above the
// sharpen/noise sliders rather than behind a pill of its own, because the
// choice frames what those sliders are operating on rather than being one
// more value to scrub.
//
// `demosaic` is a DECODE-PRODUCT field: changing it re-runs the Rust decode
// (a different reconstruction of the sensor mosaic), not a per-tick render
// — the same class of field as `lensProfileEnable` on the Lens panel and
// `deepDenoise`/`chromaPrefilter` on the Noise pill. So this writes once,
// on selection, straight to `LibraryStateService` after an
// `EditorStateService.commit()` undo snapshot, exactly as
// `LensCorrectionsPanelComponent`'s master toggle does; there is no
// drag-bar value pipe to route through.
//
// Apple's `DemosaicSection.swift` is the structural twin.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { MuiSelectComponent } from '../../ui/select/mui-select.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { DemosaicChoice } from '../../generated/adjustment-model.generated';

/**
 * Wire value → menu label. Ordered by how a photographer would reach for
 * them: the automatic answer first, then the two duals that are the
 * automatic answer's usual verdict, then the single kernels.
 *
 * The labels name what the option DOES, not the kernel's initials — nobody
 * outside this repo knows what RCD stands for — with the algorithm name
 * kept in parentheses so a user comparing against another raw developer can
 * still find it.
 */
const DEMOSAIC_OPTIONS: readonly { value: DemosaicChoice; label: string }[] = [
  { value: 'Auto', label: 'Automatic' },
  { value: 'DualAmaze', label: 'Detail + smooth (AMaZE / VNG4)' },
  { value: 'DualRcd', label: 'Detail + smooth, faster (RCD / VNG4)' },
  { value: 'Amaze', label: 'Maximum detail (AMaZE)' },
  { value: 'Rcd', label: 'Balanced (RCD)' },
  { value: 'Lmmse', label: 'High ISO (LMMSE)' },
];

@Component({
  selector: 'demosaic-panel',
  standalone: true,
  imports: [MuiSelectComponent, MuiTextComponent],
  templateUrl: './demosaic-panel.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemosaicPanelComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editorState = inject(EditorStateService);

  readonly options = DEMOSAIC_OPTIONS;

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  readonly choice = computed<DemosaicChoice>(() => this.adj()?.demosaic ?? 'Auto');

  select(value: string): void {
    const choice = DEMOSAIC_OPTIONS.find((o) => o.value === value)?.value;
    const id = this.library.focusedAssetId();
    if (choice === undefined || !id || choice === this.choice()) return;
    // Undo snapshot BEFORE the write, the ordering every other editor
    // mutator uses, so a kernel change is undoable like any other edit.
    this.editorState.commit();
    this.library.updateAdjustment(id, { demosaic: choice });
  }
}
