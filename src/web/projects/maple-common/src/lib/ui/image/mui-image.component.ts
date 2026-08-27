// MuiImage — the Maple UI design-system Image atom
// (unified-component-catalog.md §1.4; contract:
// docs/design/maple-ui/components/image.md). A raster leaf with fill/fit
// modes, radius, and a broken-image fallback rendered as a placeholder glyph
// rather than the browser's default broken-image icon.

import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';

export type MuiImageFit = 'fill' | 'fit';
export type MuiImageRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';

@Component({
  selector: 'mui-image',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-image.component.html',
  styleUrl: './mui-image.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiImageComponent {
  /** Optional so a caller can render the `placeholderBackground` gradient
   * while a real URL hasn't loaded yet (asset-tile's "thumbnail not
   * decoded" state) instead of forcing an empty-string `<img src>` through
   * the broken-image path. Still the primary way to show a photo — most
   * callers always pass a real URL. */
  readonly src = input<string>('');
  readonly alt = input.required<string>();
  readonly fit = input<MuiImageFit>('fill');
  readonly radius = input<MuiImageRadius>('md');
  /** `width / height`, e.g. `4 / 3`. Left `null` to size from the box. */
  readonly aspectRatio = input<number | null>(null);
  /** CSS `background-image` value (e.g. `url(data:image/svg+xml,...)`)
   * shown in place of the broken-image glyph while `src` is empty — the
   * "not decoded yet" gradient swatch. Ignored once `src` is non-empty;
   * has no effect on the broken-image fallback that still applies once a
   * real `src` fails to load. */
  readonly placeholderBackground = input<string | null>(null);

  readonly broken = signal(false);
  readonly loaded = signal(false);

  constructor() {
    // A new `src` gets a fresh attempt — the previous image's broken/loaded
    // state must not leak onto the next one.
    effect(() => {
      this.src();
      this.broken.set(false);
      this.loaded.set(false);
    });
  }

  onError(): void {
    this.broken.set(true);
  }

  onLoad(): void {
    this.loaded.set(true);
  }
}
