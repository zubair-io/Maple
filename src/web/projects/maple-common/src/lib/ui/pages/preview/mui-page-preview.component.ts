// MuiPagePreview — Maple UI Pages (unified-component-catalog.md §6). App
// Shell with a Preview Surface filling Content.
//
// Cross-organism wiring: the Preview Surface's `activeChanged` output
// drives the Page Header's title in the Nav region, so the title bar always
// names whichever frame is currently on screen.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiAppShellComponent } from '../../app-shell/mui-app-shell.component';
import { MuiPageHeaderComponent } from '../../page-header/mui-page-header.component';
import { MuiPreviewSurfaceComponent } from '../../preview-surface/mui-preview-surface.component';
import type { MuiPreviewSurfaceItem } from '../../preview-surface/mui-preview-surface.component';
import { pageLandscape } from '../internal/mock-media';

const ITEMS: readonly MuiPreviewSurfaceItem[] = [
  { id: 'p0', kind: 'image', src: pageLandscape(0), alt: 'Coastal Shoot — frame 1' },
  { id: 'p1', kind: 'image', src: pageLandscape(1), alt: 'Coastal Shoot — frame 2' },
  { id: 'p2', kind: 'image', src: pageLandscape(2), alt: 'Coastal Shoot — frame 3' },
];

@Component({
  selector: 'mui-page-preview',
  standalone: true,
  imports: [MuiAppShellComponent, MuiPageHeaderComponent, MuiPreviewSurfaceComponent],
  templateUrl: './mui-page-preview.component.html',
  styleUrl: './mui-page-preview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPagePreviewComponent {
  readonly items = ITEMS;
  readonly activeId = signal<string | null>(ITEMS[0].id);

  readonly headerTitle = computed<string>(
    () => this.items.find((item) => item.id === this.activeId())?.alt ?? 'Preview',
  );

  onActiveChanged(id: string): void {
    this.activeId.set(id);
  }
}
