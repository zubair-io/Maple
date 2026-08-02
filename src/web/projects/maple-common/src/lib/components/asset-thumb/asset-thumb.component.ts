// Shared asset thumbnail tile.
//
// One source of truth for: blob-URL loading via the state service,
// selection / focus ring, RAW gradient placeholder, flag indicators
// (badge or dot), star rating row, edited-XMP marker. Used by both
// `<asset-grid>` (browse) and `<editor-filmstrip>` (editor sidebar) so
// the two views stay visually + behaviourally consistent and we stop
// drifting toward duplicated thumbnail-loading logic.
//
// Selection ring uses an *inset box-shadow* rather than CSS `outline`
// because the parent thumb has `overflow: hidden` for the rounded
// corners — outline gets clipped intermittently on some renderers, the
// inset shadow never does.

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
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { Asset } from '../../models/asset';
import { LibraryStateService } from '../../state/library-state.service';
import { noPreviewBadgeLabel as computeNoPreviewBadgeLabel } from '../../state/no-preview-extensions';

export type AssetThumbVariant = 'grid' | 'filmstrip';

@Component({
  selector: 'maple-asset-thumb',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './asset-thumb.component.html',
  styleUrl: './asset-thumb.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetThumbComponent {
  /** Asset to render. Required; the binding signal handles re-renders
   * when the parent's list updates. */
  asset = input.required<Asset>();

  /** Visual: variant=grid shows badges + stars; variant=filmstrip shows dot. */
  variant = input<AssetThumbVariant>('grid');

  /** Multi-select highlight (browse). */
  selected = input<boolean>(false);

  /** Focused-asset highlight (filmstrip / arrow-key navigation). */
  focused = input<boolean>(false);

  /** Click events bubble up so the parent decides what selection /
   * navigation actions mean. Don't put click handlers in here. */
  thumbClick = output<MouseEvent>();

  readonly STAR_INDICES = [1, 2, 3, 4, 5];

  private state = inject(LibraryStateService);

  /** Select mode (#2404) — session-scoped signal on LibraryStateService.
   * Drives the checkbox affordance in the top-right corner, next to the
   * `edited` badge, while the grid's Select toggle is on. */
  readonly isSelecting = this.state.isSelecting;

  /** The blob URL for this asset, or undefined until it loads (gradient stays).
   * This component OWNS the signal, so it's created and destroyed WITH the tile —
   * the live-signal count therefore tracks the rendered tiles (the viewport when
   * the host virtualizes, e.g. the browse grid; the rendered set otherwise) and
   * never accumulates orphans. No central signal map to leak (#1363/#1359). */
  readonly thumbUrl = signal<string | undefined>(undefined);

  /** Uppercased extension (e.g. "MP3", "EIP", "MOV") when this asset is a
   * recognised no-preview format, else undefined — drives the "no preview
   * available" pill in the template. Computed from the filename alone so
   * it works the same in Hosted and Self-Hosted modes (see
   * no-preview-extensions.ts). */
  readonly noPreviewBadgeLabel = computed(
    () => computeNoPreviewBadgeLabel(this.asset().filename) ?? undefined,
  );

  constructor() {
    // Load + subscribe to this asset's thumbnail URL. effect onCleanup unsubs on
    // asset-input change and on destroy. Restructured to bypass duplicate warnings.
    //
    // Cleanup also drops the asset's *queued* thumbnail load. The browse grid
    // virtualizes, so scrolling destroys tiles continuously; without this their
    // requests stayed in the 4-wide queue and the rows actually on screen
    // waited behind hundreds of rows already scrolled past. A load already in
    // flight is left to finish.
    effect((onCleanup) => {
      const currentAsset = this.asset();
      if (currentAsset) {
        this.state.ensureThumbnailUrl(currentAsset);
        const unsub = this.state.subscribeThumbUrl(currentAsset.id, (url) => {
          this.thumbUrl.set(url);
        });
        // Order matters: unsubscribe FIRST. `cancelQueuedThumbnail` only drops
        // the queued load when no consumer is left watching that id, and this
        // tile must already be out of that count for the check to mean
        // anything. Swapping these two lines makes every cancel a no-op.
        onCleanup(() => {
          unsub();
          this.state.cancelQueuedThumbnail(currentAsset.id);
        });
      }
    });
  }
}
