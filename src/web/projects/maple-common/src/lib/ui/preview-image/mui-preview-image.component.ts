// MuiPreviewImage — the Maple UI design-system Preview Image molecule
// (unified-component-catalog.md §2.7; Built from: Image, Spinner). A static
// image with a load lifecycle: a centered spinner overlay until the image
// either loads or fails — reads `mui-image`'s own `loaded`/`broken` signals
// directly off its template-reference instance rather than duplicating
// that state here.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiImageComponent } from '../image/mui-image.component';
import type { MuiImageFit, MuiImageRadius } from '../image/mui-image.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

@Component({
  selector: 'mui-preview-image',
  standalone: true,
  imports: [MuiImageComponent, MuiSpinnerComponent],
  templateUrl: './mui-preview-image.component.html',
  host: { class: 'block h-full w-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPreviewImageComponent {
  readonly src = input.required<string>();
  readonly alt = input.required<string>();
  readonly fit = input<MuiImageFit>('fill');
  readonly radius = input<MuiImageRadius>('md');
  readonly aspectRatio = input<number | null>(null);
}
