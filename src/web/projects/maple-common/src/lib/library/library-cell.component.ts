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
// `LibraryStateService.ensureThumbnailUrl` via the same effect pattern
// used by `<maple-asset-thumb>` so the four loader paths (FS-walk /
// Mongo / .maple cache / WASM decode) stay in one place.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
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

  readonly thumbUrl = computed(() => this.state.thumbnailUrlFor(this.asset().id));
  readonly stars = computed(() => Math.min(5, Math.max(0, this.asset().rating)));
  readonly isPick = computed(() => this.asset().flag === 'pick');
  readonly showStars = computed(() => this.stars() >= 4);

  /** 0..stars range for the *ngFor in the template. */
  readonly starIndices = computed(() => Array.from({ length: this.stars() }, (_, i) => i));

  constructor() {
    // Kick off thumbnail load whenever the bound asset changes. Loader
    // dedupe lives in the state service.
    effect(() => {
      const a = this.asset();
      if (a) this.state.ensureThumbnailUrl(a);
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
