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
  signal,
} from '@angular/core';
import { Asset } from '../models/asset';
import { LibraryStateService } from '../state/library-state.service';
import { MapleIconComponent } from '../icons/maple-icon.component';
import { AssetRenameService } from '../rename/asset-rename.service';
import { InlineRenameFieldComponent } from '../components/inline-rename-field/inline-rename-field.component';

@Component({
  selector: 'app-library-cell',
  standalone: true,
  imports: [MapleIconComponent, InlineRenameFieldComponent],
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
  protected readonly renameSvc = inject(AssetRenameService);

  /** True while this cell's filename bar is showing the inline-rename
   * field (#2637). Only one cell in the grid is ever editing at a time —
   * `AssetRenameService.editingAssetId` is shared, not per-cell state. */
  readonly isEditingFilename = computed(() => this.renameSvc.editingAssetId() === this.asset().id);

  /** Why rename is unavailable for this asset, or '' when it's allowed —
   * surfaced as the filename bar's `title` tooltip. */
  readonly renameDisabledReason = computed(() => this.renameSvc.disabledReason(this.asset()) ?? '');

  onFilenameDblClick(asset: Asset, event: MouseEvent): void {
    event.stopPropagation();
    this.renameSvc.startEditing(asset);
  }

  onRenameCommit(asset: Asset, newFilename: string): void {
    this.renameSvc.commit(asset, newFilename);
  }

  onCollisionResolved(asset: Asset, policy: 'replace' | 'keep-both'): void {
    this.renameSvc.resolveCollision(asset, policy);
  }

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
