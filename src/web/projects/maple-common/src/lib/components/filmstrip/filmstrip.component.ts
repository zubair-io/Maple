// Filmstrip — single-row horizontal scroll; highlights focused asset.
// Click selects + routes. Focused asset scrolls into view via effect.

import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  QueryList,
  ViewChildren,
  effect,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { Asset } from '../../models/asset';

@Component({
  selector: 'editor-filmstrip',
  standalone: true,
  imports: [],
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      width: 110px;
      min-width: 110px;
      height: 100%;
      background: var(--maple-sidebar);
      border-right: 0.5px solid var(--maple-border);
      overflow: hidden;
    }

    .strip-title {
      flex-shrink: 0;
      padding: 8px 10px 6px;
      font-family: var(--maple-font);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--maple-text-muted);
      border-bottom: 0.5px solid var(--maple-border);
    }

    .strip-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .strip-scroll::-webkit-scrollbar { width: 4px; }
    .strip-scroll::-webkit-scrollbar-track { background: transparent; }
    .strip-scroll::-webkit-scrollbar-thumb { background: var(--maple-border); border-radius: 2px; }

    .thumb {
      flex-shrink: 0;
      border-radius: 2px;
      cursor: pointer;
      position: relative;
      background-size: cover;
      background-position: center;
      overflow: hidden;
      outline: 2px solid transparent;
      outline-offset: -2px;
      transition: outline-color 80ms;
    }
    .thumb.focused {
      outline-color: var(--maple-primary);
    }
    .thumb:not(.focused):hover { outline-color: rgba(255,255,255,0.2); }

    /* Flag dot overlay */
    .flag-dot {
      position: absolute;
      bottom: 3px;
      left: 3px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .flag-dot.pick   { background: var(--maple-success-text); }
    .flag-dot.reject { background: var(--maple-error-text); }

    /* Edited dot */
    .edited-dot {
      position: absolute;
      top: 3px;
      right: 3px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--maple-primary);
    }
  `],
  template: `
    <div class="strip-title">{{ state.assetsInSelectedFolder().length }} photos</div>

    <div class="strip-scroll" #scrollContainer>
      @for (asset of state.assetsInSelectedFolder(); track asset.id) {
        @let isFocused = state.focusedAssetId() === asset.id;
        <div
          class="thumb"
          [class.focused]="isFocused"
          [style.height.px]="thumbH(asset)"
          [style.background-image]="'url(' + asset.thumbnailGradient + ')'"
          [attr.data-id]="asset.id"
          (click)="select(asset)">
          @if (asset.flag === 'pick') {
            <div class="flag-dot pick"></div>
          } @else if (asset.flag === 'reject') {
            <div class="flag-dot reject"></div>
          }
          @if (asset.edited) {
            <div class="edited-dot"></div>
          }
        </div>
      }
    </div>
  `,
})
export class FilmstripComponent implements AfterViewInit, OnDestroy {
  @ViewChildren('[data-id]') thumbEls!: QueryList<ElementRef<HTMLElement>>;

  state   = inject(LibraryStateService);
  private router = inject(Router);

  private cleanupEffect?: () => void;

  thumbH(asset: Asset): number {
    const w = 102; // strip width - 2*4 padding
    return Math.round(w / asset.aspectRatio);
  }

  ngAfterViewInit(): void {
    const e = effect(() => {
      const fid = this.state.focusedAssetId();
      if (!fid) return;
      // Scroll focused thumb into view
      requestAnimationFrame(() => {
        const el = this.thumbEls?.find(t => t.nativeElement.dataset['id'] === fid);
        el?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
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
