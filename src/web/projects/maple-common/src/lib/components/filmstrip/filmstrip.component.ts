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
  styles: [
    `
      /* 0.5px borders + ::-webkit-scrollbar pseudos can't be expressed as
         Tailwind utilities — keep them in CSS. */
      :host {
        border-right: 0.5px solid var(--color-border);
      }

      .strip-title {
        border-bottom: 0.5px solid var(--color-border);
      }

      .strip-scroll::-webkit-scrollbar {
        width: 4px;
      }
      .strip-scroll::-webkit-scrollbar-track {
        background: transparent;
      }
      .strip-scroll::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: 2px;
      }
    `,
  ],
  host: {
    class:
      'flex flex-col w-[110px] min-w-[110px] h-full bg-sidebar overflow-hidden',
  },
  template: `
    <div
      class="strip-title shrink-0 pl-2.5 pr-2.5 pt-2 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-text-muted"
    >{{ state.assetsInSelectedFolder().length }} photos</div>

    <div class="strip-scroll flex-1 overflow-y-auto p-1 flex flex-col gap-[3px]" #scrollContainer>
      @for (asset of state.assetsInSelectedFolder(); track asset.id) {
        @let isFocused = state.focusedAssetId() === asset.id;
        <div
          class="shrink-0"
          [style.height.px]="thumbH(asset)"
          [attr.data-id]="asset.id"
        >
          <maple-asset-thumb
            [asset]="asset"
            variant="filmstrip"
            [focused]="isFocused"
            (thumbClick)="select(asset)"
          />
        </div>
      }
    </div>
  `,
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
