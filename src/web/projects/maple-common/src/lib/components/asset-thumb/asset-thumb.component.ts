// Editor filmstrip's thumbnail tile. Filmstrip-only remnant of what used to
// be a shared `<maple-asset-thumb>` with a `variant: 'grid' | 'filmstrip'`
// branch — the grid branch moved onto Maple UI composition as its own
// `<maple-asset-tile>` component (MW6, ticket #3047); this one is
// deliberately left untouched, hand-rolled markup, reserved for the
// perf-gated editor wave that owns `editor-filmstrip`'s decode-hot render
// path (#2520/#2526 history). See that wave's plan before touching this
// file's template.
//
// Selection ring uses an *inset box-shadow* rather than CSS `outline`
// because the parent thumb has `overflow: hidden` for the rounded
// corners — outline gets clipped intermittently on some renderers, the
// inset shadow never does.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Asset } from '../../models/asset';
import { createAssetThumbnailUrlSignal } from '../../state/asset-thumbnail-url-signal';

@Component({
  selector: 'maple-asset-thumb',
  standalone: true,
  imports: [],
  templateUrl: './asset-thumb.component.html',
  host: { class: 'block w-full h-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetThumbComponent {
  /** Asset to render. Required; the binding signal handles re-renders
   * when the parent's list updates. */
  asset = input.required<Asset>();

  /** Focused-asset highlight (arrow-key navigation). */
  focused = input<boolean>(false);

  /** Click events bubble up so the parent decides what selection /
   * navigation actions mean. Don't put click handlers in here. */
  thumbClick = output<MouseEvent>();

  /** The blob URL for this asset, or undefined until it loads (gradient
   * placeholder stays) — see `createAssetThumbnailUrlSignal`'s doc for the
   * ownership/cleanup contract, shared verbatim with `<maple-asset-tile>`. */
  readonly thumbUrl = createAssetThumbnailUrlSignal(this.asset);
}
