// MuiImage — the Maple UI design-system Image atom
// (unified-component-catalog.md §1.4; contract:
// docs/design/maple-ui/components/image.md). A raster leaf with fill/fit
// modes, radius, and a broken-image fallback rendered as a placeholder glyph
// rather than the browser's default broken-image icon.

import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';

export type MuiImageFit = 'fill' | 'fit';
export type MuiImageRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';

const RADIUS_CLASS: Record<MuiImageRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-xl',
  full: 'rounded-full',
};

const FIT_CLASS: Record<MuiImageFit, string> = {
  fill: 'object-cover',
  fit: 'object-contain',
};

@Component({
  selector: 'mui-image',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-image.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
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

  // Bare `radius-<x>` / `fit-<x>` / `is-loaded` markers are kept alongside
  // the utility classes below — mui-image.component.spec.ts asserts on
  // them directly (`.toContain('fit-fill')`, `.toContain('radius-full')`,
  // `.toContain('is-loaded')`).
  readonly radiusClass = computed(() => `radius-${this.radius()} ${RADIUS_CLASS[this.radius()]}`);
  readonly fitClass = computed(() => `fit-${this.fit()} ${FIT_CLASS[this.fit()]}`);

  /** Opacity is a single computed rather than a base `opacity-0` plus a
   * conditional `is-loaded` add-on, per the recipe's rule against layering
   * a conditional utility on top of a base one for the same property. */
  readonly pixelsClass = computed(() =>
    this.loaded() ? `${this.fitClass()} is-loaded opacity-100` : `${this.fitClass()} opacity-0`,
  );

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
