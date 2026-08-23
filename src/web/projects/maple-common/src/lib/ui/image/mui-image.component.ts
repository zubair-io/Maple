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
  readonly src = input.required<string>();
  readonly alt = input.required<string>();
  readonly fit = input<MuiImageFit>('fill');
  readonly radius = input<MuiImageRadius>('md');
  /** `width / height`, e.g. `4 / 3`. Left `null` to size from the box. */
  readonly aspectRatio = input<number | null>(null);

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
