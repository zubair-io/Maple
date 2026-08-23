// MuiDragPreview — the Maple UI design-system Drag Preview molecule
// (unified-component-catalog.md §2.7; Built from: Image, Badge). The ghost
// thumbnail shown under the cursor while dragging one or more assets — a
// slightly rotated, reduced-opacity card with a "+N" count badge when more
// than one item is being dragged. Purely presentational: the actual
// drag-and-drop wiring (HTML5 DnD / pointer-based drag service) lives at
// the app layer and supplies this component's inputs.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiImageComponent } from '../image/mui-image.component';
import { MuiBadgeComponent } from '../badge/mui-badge.component';

@Component({
  selector: 'mui-drag-preview',
  standalone: true,
  imports: [MuiImageComponent, MuiBadgeComponent],
  templateUrl: './mui-drag-preview.component.html',
  styleUrl: './mui-drag-preview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiDragPreviewComponent {
  readonly src = input.required<string>();
  readonly alt = input<string>('Dragged item');
  /** Total items being dragged; a badge appears once this is greater than 1. */
  readonly count = input<number>(1);
}
