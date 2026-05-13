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
} from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { Asset } from '../../models/asset';
import { LibraryStateService } from '../../state/library-state.service';

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
  thumbDblClick = output<MouseEvent>();

  readonly STAR_INDICES = [1, 2, 3, 4, 5];

  private state = inject(LibraryStateService);

  /** The blob URL for this asset, or undefined if it hasn't loaded yet
   * (or if the asset has no absPath — gradient stays). */
  readonly thumbUrl = computed(() => this.state.thumbnailUrlFor(this.asset().id));

  constructor() {
    // Kick off the load whenever the bound asset changes. State-level
    // dedupe handles repeat calls — this just ensures the request is in
    // flight on mount.
    effect(() => {
      const a = this.asset();
      if (a) this.state.ensureThumbnailUrl(a);
    });
  }
}
