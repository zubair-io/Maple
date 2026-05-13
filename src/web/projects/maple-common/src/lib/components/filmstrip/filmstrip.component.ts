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
} from '@angular/core';
import { Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { Asset } from '../../models/asset';
import { AssetThumbComponent } from '../asset-thumb/asset-thumb.component';

@Component({
  selector: 'editor-filmstrip',
  standalone: true,
  imports: [AssetThumbComponent],
  styleUrl: './filmstrip.component.scss',
  host: {
    class:
      'flex flex-col w-[110px] min-w-[110px] h-full bg-sidebar overflow-hidden',
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
    void this.router.navigate(['/edit', asset.id]);
  }
}
