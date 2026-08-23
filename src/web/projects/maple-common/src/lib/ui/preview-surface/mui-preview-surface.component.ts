// MuiPreviewSurface — the Maple UI design-system Preview Surface organism
// (unified-component-catalog.md §4.5; Built from: Page Header, Filmstrip Row,
// Preview Image, Video Player, Toolbar). A full-screen media preview: a
// header with a back action and a zoom/rotate/info toolbar, a stage that
// swaps between an image and a video player depending on the active item's
// kind, and a bottom filmstrip for picking a different item.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiPageHeaderComponent } from '../page-header/mui-page-header.component';
import { MuiToolbarComponent } from '../toolbar/mui-toolbar.component';
import type { MuiToolbarEntry } from '../toolbar/mui-toolbar.component';
import { MuiFilmstripRowComponent } from '../filmstrip-row/mui-filmstrip-row.component';
import { MuiPreviewImageComponent } from '../preview-image/mui-preview-image.component';
import { MuiVideoPlayerComponent } from '../video-player/mui-video-player.component';

export interface MuiPreviewSurfaceItem {
  readonly id: string;
  readonly kind: 'image' | 'video';
  readonly src: string;
  readonly alt: string;
}

const TOOLBAR_ENTRIES: readonly MuiToolbarEntry[] = [
  { id: 'zoom-in', icon: 'zoom-in', label: 'Zoom in' },
  { id: 'zoom-out', icon: 'zoom-out', label: 'Zoom out' },
  { id: 'rotate', icon: 'redo-uturn', label: 'Rotate' },
  { divider: true },
  { id: 'info', icon: 'info', label: 'Info' },
];

@Component({
  selector: 'mui-preview-surface',
  standalone: true,
  imports: [
    MuiPageHeaderComponent,
    MuiToolbarComponent,
    MuiFilmstripRowComponent,
    MuiPreviewImageComponent,
    MuiVideoPlayerComponent,
  ],
  templateUrl: './mui-preview-surface.component.html',
  styleUrl: './mui-preview-surface.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPreviewSurfaceComponent {
  readonly items = input.required<readonly MuiPreviewSurfaceItem[]>();
  readonly activeId = model<string | null>(null);
  readonly title = input<string>('Preview');

  readonly activeChanged = output<string>();
  readonly closed = output<void>();
  /** Bubbles the raw toolbar entry id (zoom-in / zoom-out / rotate / info)
   * rather than a dedicated output per action — the simplest correct shape
   * for a reference shell with no real zoom/rotate state to own. */
  readonly toolbarAction = output<string>();

  readonly toolbarEntries = TOOLBAR_ENTRIES;

  readonly activeItem = computed<MuiPreviewSurfaceItem | null>(
    () => this.items().find((item) => item.id === this.activeId()) ?? null,
  );

  onFilmstripActivated(id: string): void {
    this.activeChanged.emit(id);
  }
}
