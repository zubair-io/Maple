// Shared asset thumbnail tile.
//
// One source of truth for: blob-URL loading via the state service,
// selection / focus ring, RAW gradient placeholder, flag indicators
// (badge or dot), star rating row, edited-XMP marker. Used by both
// `<asset-grid>` (browse) and `<editor-filmstrip>` (editor sidebar) so
// the two views stay visually + behaviourally consistent and we stop
// drifting toward duplicated thumbnail-loading logic.
//
// Selection ring uses an *inset box-shadow* rather than CSS `outline`
// because the parent thumb has `overflow: hidden` for the rounded
// corners — outline gets clipped intermittently on some renderers, the
// inset shadow never does.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { Asset } from '../../models/asset';
import { LibraryStateService } from '../../state/library-state.service';

export type AssetThumbVariant = 'grid' | 'filmstrip';

@Component({
  selector: 'maple-asset-thumb',
  standalone: true,
  imports: [MapleIconComponent],
  template: `
    @let a = asset();
    @let url = thumbUrl();
    <div
      class="thumb relative h-full w-full flex-shrink-0 cursor-pointer overflow-hidden rounded-[2px] bg-cover bg-center outline-none"
      [class.selected]="selected()"
      [class.focused]="focused()"
      [class.variant-grid]="variant() === 'grid'"
      [class.variant-filmstrip]="variant() === 'filmstrip'"
      [style.background-image]="url ? '' : 'url(' + a.thumbnailGradient + ')'"
      (click)="thumbClick.emit($event)"
      (dblclick)="thumbDblClick.emit($event)"
    >
      @if (url) {
        <img class="absolute inset-0 block h-full w-full object-cover" [src]="url" alt="" loading="lazy" decoding="async" />
      }

      <!-- Selection / focus ring. Separate overlay element so it stacks
           above the absolutely-positioned <img>; box-shadow/outline render
           on the .thumb itself which the img completely obscures. -->
      <div class="thumb-ring pointer-events-none absolute inset-0 rounded-[2px] border-2 border-transparent transition-[border-color] duration-[80ms]" aria-hidden="true"></div>

      @if (a.edited && variant() === 'grid') {
        <div class="absolute right-[5px] top-[5px] flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border-[0.5px] border-success-text bg-success-bg backdrop-blur-[4px]">
          <maple-icon name="check" [size]="9" [strokeWidth]="2" color="var(--color-success-text)" />
        </div>
      } @else if (a.edited && variant() === 'filmstrip') {
        <div class="absolute right-[3px] top-[3px] h-[5px] w-[5px] rounded-full bg-primary"></div>
      }

      @if (variant() === 'grid') {
        <div class="pointer-events-none absolute bottom-[5px] left-[5px] right-[5px] flex items-end justify-between gap-1">
          <div class="flex gap-[3px]">
            @if (a.flag === 'pick') {
              <div class="rounded-[3px] bg-success-bg px-1 py-0.5 text-[9px] font-semibold tracking-[0.3px] text-success-text backdrop-blur-[4px]">PICK</div>
            }
            @if (a.flag === 'reject') {
              <div class="rounded-[3px] bg-error-bg px-1 py-0.5 text-[9px] font-semibold tracking-[0.3px] text-error-text backdrop-blur-[4px]">REJECT</div>
            }
          </div>
          @if (a.rating > 0) {
            <div class="flex gap-px rounded-[3px] bg-black/45 px-1 py-0.5 backdrop-blur-[4px]">
              @for (i of STAR_INDICES; track i) {
                <maple-icon
                  [name]="i <= a.rating ? 'star-filled' : 'star'"
                  [size]="8"
                  [color]="i <= a.rating ? 'var(--color-star)' : 'rgba(255,255,255,0.35)'"
                />
              }
            </div>
          }
        </div>
      } @else {
        @if (a.flag === 'pick') {
          <div class="absolute bottom-[3px] left-[3px] h-[6px] w-[6px] rounded-full bg-success-text"></div>
        } @else if (a.flag === 'reject') {
          <div class="absolute bottom-[3px] left-[3px] h-[6px] w-[6px] rounded-full bg-error-text"></div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        /* Fill the parent .thumb-wrap so the inner .thumb (and the <img>'s
           height:100%) have a definite size to resolve against. Without this
           the host stays block-default-auto-height → .thumb collapses to 0
           → the <img> renders 0×0. */
        display: block;
        width: 100%;
        height: 100%;
      }

      /* Selection / focus ring colour, driven by parent-class state.
         Tailwind utilities express transparent default + position; this rule
         only handles the conditional border-color flips that depend on the
         .selected / .focused / hover state of the parent .thumb. */
      .thumb.selected .thumb-ring,
      .thumb.focused .thumb-ring {
        border-color: var(--color-primary);
      }
      .thumb.variant-filmstrip:not(.focused):hover .thumb-ring {
        border-color: rgba(255, 255, 255, 0.2);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetThumbComponent {
  /** Asset to render. Required; the binding signal handles re-renders
   * when the parent's list updates. */
  asset = input.required<Asset>();

  /** Visual: variant=grid shows badges + stars; variant=filmstrip shows dot. */
  variant = input<AssetThumbVariant>('grid');

  /** Multi-select highlight (browse). */
  selected = input<boolean>(false);

  /** Focused-asset highlight (filmstrip / arrow-key navigation). */
  focused = input<boolean>(false);

  /** Click events bubble up so the parent decides what selection /
   * navigation actions mean. Don't put click handlers in here. */
  thumbClick = output<MouseEvent>();
  thumbDblClick = output<MouseEvent>();

  readonly STAR_INDICES = [1, 2, 3, 4, 5];

  private state = inject(LibraryStateService);

  /** The blob URL for this asset, or undefined if it hasn't loaded yet
   * (or if the asset has no absPath — gradient stays). */
  readonly thumbUrl = computed(() => this.state.thumbnailUrlFor(this.asset().id));

  constructor() {
    // Kick off the load whenever the bound asset changes. State-level
    // dedupe handles repeat calls — this just ensures the request is in
    // flight on mount.
    effect(() => {
      const a = this.asset();
      if (a) this.state.ensureThumbnailUrl(a);
    });
  }
}
