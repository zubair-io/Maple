// MuiRemoteImage — the Maple UI design-system Remote Image atom
// (unified-component-catalog.md §1.4; contract:
// docs/design/maple-ui/components/remote-image.md). Loads a tiered set of
// URLs (thumb → preview → full) in order, swapping the displayed source up
// to progressively sharper tiers as each preload resolves — a blur-up
// transition rather than a hard cut. A tier that fails to load is skipped
// rather than aborting the whole sequence; the atom only reports an error
// once every tier has failed.
//
// `handleTierLoaded`/`handleTierError` are public so tests (and the
// showcase) can drive the state machine synchronously instead of racing a
// real network `Image` load — the constructor still wires up real
// `new Image()` preloads for actual usage.

import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';

export type MuiRemoteImageTier = 'thumb' | 'preview' | 'full';

export interface MuiRemoteImageTiers {
  readonly thumb?: string;
  readonly preview?: string;
  readonly full?: string;
}

const TIER_ORDER: readonly MuiRemoteImageTier[] = ['thumb', 'preview', 'full'];

@Component({
  selector: 'mui-remote-image',
  standalone: true,
  templateUrl: './mui-remote-image.component.html',
  styleUrl: './mui-remote-image.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiRemoteImageComponent {
  readonly tiers = input.required<MuiRemoteImageTiers>();
  readonly alt = input.required<string>();
  readonly fit = input<'fill' | 'fit'>('fill');

  readonly displaySrc = signal<string | null>(null);
  readonly displayTier = signal<MuiRemoteImageTier | null>(null);
  readonly status = signal<'loading' | 'loaded' | 'error'>('loading');

  /** Tiers this pass hasn't attempted yet, in `thumb → preview → full` order. */
  private queue: MuiRemoteImageTier[] = [];

  constructor() {
    effect(() => {
      const tiers = this.tiers();
      this.beginLoad(tiers);
    });
  }

  retry(): void {
    this.beginLoad(this.tiers());
  }

  private beginLoad(tiers: MuiRemoteImageTiers): void {
    this.queue = TIER_ORDER.filter((tier) => !!tiers[tier]);
    this.displaySrc.set(null);
    this.displayTier.set(null);
    this.status.set(this.queue.length > 0 ? 'loading' : 'error');
    this.loadNext(tiers);
  }

  private loadNext(tiers: MuiRemoteImageTiers): void {
    const tier = this.queue.shift();
    if (!tier) {
      if (this.displaySrc() === null) this.status.set('error');
      return;
    }
    const url = tiers[tier]!;
    const preload = new Image();
    preload.onload = () => this.handleTierLoaded(tier, url, tiers);
    preload.onerror = () => this.handleTierError(tiers);
    preload.src = url;
  }

  handleTierLoaded(tier: MuiRemoteImageTier, url: string, tiers: MuiRemoteImageTiers): void {
    this.displaySrc.set(url);
    this.displayTier.set(tier);
    this.status.set('loaded');
    this.loadNext(tiers);
  }

  handleTierError(tiers: MuiRemoteImageTiers): void {
    this.loadNext(tiers);
  }
}
