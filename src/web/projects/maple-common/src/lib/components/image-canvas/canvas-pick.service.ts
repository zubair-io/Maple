// CanvasPickService — the canvas's point-pick mode, shared by every
// eyedropper (#2434 white balance, #362 mask colour range).
//
// An eyedropper is a two-step gesture across two components: a panel control
// arms the mode and waits, the canvas resolves it with the point that was
// clicked. This service is the only thing they share — a signal the canvas
// reads to change its cursor and route its next click, the instruction to
// show while armed, and one pending resolver.
//
// At most one pick is ever in flight: arming again cancels the previous wait
// (resolving it `null`), so a second eyedropper press — from the same panel
// or a different one — can never leave the first caller hanging.

import { Injectable, signal } from '@angular/core';
import type { NormalisedPoint } from './image-canvas.wb-pick';

/** Instruction shown in the overlay while a pick is armed. */
export const WB_PICK_PROMPT = 'Click a neutral surface';
export const RANGE_PICK_PROMPT = 'Click the colour the mask should select';

@Injectable({ providedIn: 'root' })
export class CanvasPickService {
  /** True while the canvas is waiting for a pick. */
  readonly active = signal(false);

  /** What the armed pick is asking for — the overlay's live-region text. */
  readonly prompt = signal<string>(WB_PICK_PROMPT);

  private resolver: ((point: NormalisedPoint | null) => void) | null = null;

  /**
   * Arm pick mode and resolve with the point the user clicks, or `null` if
   * the pick is cancelled (Escape, a click on the letterbox, a second arm).
   */
  arm(prompt: string = WB_PICK_PROMPT): Promise<NormalisedPoint | null> {
    this.settle(null);
    this.prompt.set(prompt);
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
