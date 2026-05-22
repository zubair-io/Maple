// Capture sharpening section — Maple-proprietary Richardson-Lucy
// deconvolution (#271). Distinct from the ACR-style unsharp-mask
// sliders in `editor-sharpening-section`; runs post-DCP in the Rust
// scene-linear chain, sees the calibrated sensor signal before any
// user tone/WB transforms. Off by default (amount = 0).

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';

@Component({
  selector: 'editor-capture-sharpening-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent],
  templateUrl: './capture-sharpening-section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureSharpeningSectionComponent {
  private state = inject(LibraryStateService);
  assetId = computed(() => this.state.focusedAssetId());
  adj = computed(() => {
    const id = this.assetId();
    return id ? this.state.adjustmentFor(id)() : null!;
  });

  patch(field: string, value: number): void {
    const id = this.assetId();
    if (id) this.state.updateAdjustment(id, { [field]: value } as never);
  }
}
