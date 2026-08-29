// MuiMapAnnotation — the Maple UI design-system Map Annotation molecule
// (unified-component-catalog.md §2.7; Built from: Image, Badge, Text). A
// map pin: a thumbnail (or a fallback glyph when no photo is given) inside
// a teardrop pin shape, with an optional cluster-count badge and caption.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiImageComponent } from '../image/mui-image.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-map-annotation',
  standalone: true,
  imports: [MuiImageComponent, MuiIconComponent, MuiBadgeComponent, MuiTextComponent],
  templateUrl: './mui-map-annotation.component.html',
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiMapAnnotationComponent {
  readonly src = input<string | null>(null);
  readonly label = input<string | null>(null);
  readonly count = input<number | null>(null);
}
