// WbPickService — the canvas's white-balance pick mode (#2434).
//
// The eyedropper is a two-step gesture across two components: the WB pad arms
// the mode and waits, the canvas resolves it with the point that was clicked.
// This service is the only thing they share — a signal the canvas reads to
// change its cursor and route its next click, and one pending resolver.
//
// At most one pick is ever in flight: arming again cancels the previous wait
// (resolving it `null`), so a second eyedropper press can never leave the
// first caller hanging.

import { Injectable, signal } from '@angular/core';
import type { NormalisedPoint } from './image-canvas.wb-pick';

@Injectable({ providedIn: 'root' })
export class WbPickService {
  /** True while the canvas is waiting for a white-balance pick. */
  readonly active = signal(false);

  private resolver: ((point: NormalisedPoint | null) => void) | null = null;

  /**
   * Arm pick mode and resolve with the point the user clicks, or `null` if
   * the pick is cancelled (Escape, a click on the letterbox, a second arm).
   */
  arm(): Promise<NormalisedPoint | null> {
    this.settle(null);
    this.active.set(true);
    return new Promise<NormalisedPoint | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Resolve an armed pick with the clicked point. */
  resolve(point: NormalisedPoint): void {
    this.settle(point);
  }

  /** Cancel an armed pick — the awaiting caller sees `null`. */
  cancel(): void {
    this.settle(null);
  }

  private settle(point: NormalisedPoint | null): void {
    const resolver = this.resolver;
    this.resolver = null;
    this.active.set(false);
    resolver?.(point);
  }
}
