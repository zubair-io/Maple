// Filmstrip — single-row horizontal scroll; highlights focused asset.
// Click selects + routes. Focused asset scrolls into view via effect.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  QueryList,
  ViewChildren,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { Asset } from '../../models/asset';
import { editRouteCommands, viewRouteCommands } from '../../addressing/route-address';
import { AssetThumbComponent } from '../asset-thumb/asset-thumb.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';

@Component({
  selector: 'editor-filmstrip',
  standalone: true,
  imports: [AssetThumbComponent, MapleIconComponent],
  styleUrl: './filmstrip.component.scss',
  host: {
    class: 'flex flex-col w-[110px] min-w-[110px] overflow-hidden',
  },
  templateUrl: './filmstrip.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilmstripComponent implements AfterViewInit, OnDestroy {
  @ViewChildren('[data-id]') thumbEls!: QueryList<ElementRef<HTMLElement>>;

  state = inject(LibraryStateService);
  private router = inject(Router);
  private readonly injector = inject(Injector);

  private cleanupEffect?: () => void;

  /** Collapse toggle — hides the thumbnails, leaving the FILMSTRIP header. */
  readonly collapsed = signal(false);

  /** Which route family `select()` navigates into: the editor (`'edit'`,
   * default — unchanged behavior for the existing editor filmstrip) or the
   * fast Preview surface (`'view'`, used when this filmstrip is embedded in
   * `PreviewShellComponent`). */
  readonly routeMode = input<'edit' | 'view'>('edit');

  thumbH(asset: Asset): number {
    const w = 102; // strip width - 2*4 padding
    return Math.round(w / asset.aspectRatio);
  }

  ngAfterViewInit(): void {
    const e = effect(
      () => {
        const fid = this.state.focusedAssetId();
        if (!fid) return;
        // Scroll focused thumb into view
        requestAnimationFrame(() => {
          const el = this.thumbEls?.find((t) => t.nativeElement.dataset['id'] === fid);
          el?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      },
      { injector: this.injector },
    );
    this.cleanupEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.cleanupEffect?.();
  }

  select(asset: Asset): void {
    this.state.selectAsset(asset.id);
    const cmds =
      this.routeMode() === 'view' ? viewRouteCommands(asset.id) : editRouteCommands(asset.id);
    void this.router.navigate(cmds);
  }
}
