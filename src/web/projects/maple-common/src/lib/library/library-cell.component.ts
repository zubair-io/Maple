// library-cell.component.ts — single thumbnail cell for the responsive
// Library grid (responsive-program S2, #623).
//
// Square 1:1, rounded corners, center-cover thumbnail, badge overlay:
//
//   * pick dot   — 6px green circle, top-left 4px inset, when
//                  `asset.flag === 'pick'`.
//   * stars (≥4) — 6px gold star glyphs, bottom-left 4px inset, when
//                  `asset.rating >= 4`.
//
// No reject badge in v0.1 per the spec. Thumbnail loading delegates to
// `LibraryStateService.ensureThumbnailUrl` via the same effect pattern used
// by `<maple-asset-tile>` (browse grid) and `<maple-asset-thumb>` (editor
// filmstrip) so the four loader paths (FS-walk / Mongo / .maple cache /
// WASM decode) stay in one place.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Asset } from '../models/asset';
import { LibraryStateService } from '../state/library-state.service';
import { MapleIconComponent } from '../icons/maple-icon.component';

@Component({
  selector: 'app-library-cell',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './library-cell.component.html',
  styleUrl: './library-cell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryCellComponent {
  /** Asset to render. */
  asset = input.required<Asset>();

  /** Emitted on cell tap. Parent decides destination (Editor push). */
  cellTap = output<Asset>();

  private state = inject(LibraryStateService);

  // Component-owned signal — created/destroyed with the cell, so its lifecycle
  // bounds the live count (no central signal map to leak; #1363/#1359).
  readonly thumbUrl = signal<string | undefined>(undefined);
  readonly stars = computed(() => Math.min(5, Math.max(0, this.asset().rating)));
  readonly isPick = computed(() => this.asset().flag === 'pick');
  readonly showStars = computed(() => this.stars() >= 4);

  /** 0..stars range for the *ngFor in the template. */
  readonly starIndices = computed(() => Array.from({ length: this.stars() }, (_, i) => i));

  constructor() {
    // Load + subscribe to this asset's thumbnail URL. effect onCleanup unsubs on
    // asset-input change and on destroy, so the subscription dies with the cell.
    effect((onCleanup) => {
      const a = this.asset();
      if (!a) return;
      this.state.ensureThumbnailUrl(a);
      const unsubscribe = this.state.subscribeThumbUrl(a.id, (url) => this.thumbUrl.set(url));
      onCleanup(unsubscribe);
    });
  }

  onClick(): void {
    // Selection haptic on devices that support it. Spec §2 phone
    // interaction model — silent no-op on browsers without the
    // Vibration API (e.g. Safari macOS).
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(4);
    }
    this.cellTap.emit(this.asset());
  }
}
