// MuiPageTvViewer — Maple UI Pages (unified-component-catalog.md §6). App
// Shell with the Preview Surface filling Content, framed for a living-room
// remote — minimal chrome, a position counter in Nav, and a caption
// overlaid on the surface itself rather than in a title bar.
//
// Cross-organism wiring: the Preview Surface's `activeChanged` output drives
// both the Nav position counter ("2 of 3") and the caption overlay text.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiAppShellComponent } from '../../app-shell/mui-app-shell.component';
import { MuiTextComponent } from '../../text/mui-text.component';
import { MuiPreviewSurfaceComponent } from '../../preview-surface/mui-preview-surface.component';
import type { MuiPreviewSurfaceItem } from '../../preview-surface/mui-preview-surface.component';
import { pageLandscape } from '../internal/mock-media';

const ITEMS: readonly MuiPreviewSurfaceItem[] = [
  { id: 'tv0', kind: 'image', src: pageLandscape(3), alt: 'Wedding first look' },
  { id: 'tv1', kind: 'image', src: pageLandscape(4), alt: 'Wedding reception' },
  { id: 'tv2', kind: 'image', src: pageLandscape(5), alt: 'Wedding toast' },
];

@Component({
  selector: 'mui-page-tv-viewer',
  standalone: true,
  imports: [MuiAppShellComponent, MuiTextComponent, MuiPreviewSurfaceComponent],
  templateUrl: './mui-page-tv-viewer.component.html',
  styleUrl: './mui-page-tv-viewer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageTvViewerComponent {
  readonly items = ITEMS;
  readonly activeId = signal<string | null>(ITEMS[0].id);

  private readonly activeIndex = computed<number>(() =>
    Math.max(
      0,
      this.items.findIndex((item) => item.id === this.activeId()),
    ),
  );

  readonly positionLabel = computed<string>(
    () => `${this.activeIndex() + 1} of ${this.items.length}`,
  );
  readonly caption = computed<string>(() => this.items[this.activeIndex()]?.alt ?? '');

  onActiveChanged(id: string): void {
    this.activeId.set(id);
  }
}
