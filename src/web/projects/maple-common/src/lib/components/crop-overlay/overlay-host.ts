// overlay-host.ts — the bits every canvas overlay needs (#1541): the host's
// live size, the focused asset's dimensions, and pointer → host-local
// coordinates. Shared by `CropOverlayComponent` and `MaskOverlayComponent`
// so the two overlays can't drift on how they measure the canvas wrap.

import { computed, type Signal, type WritableSignal } from '@angular/core';
import type { LibraryStateService } from '../../state/library-state.service';

/** Seed `wrapW`/`wrapH` from `el` and keep them in step with its content box.
 *  The caller disconnects the returned observer on destroy. */
export function observeHostSize(
  el: HTMLElement,
  wrapW: WritableSignal<number>,
  wrapH: WritableSignal<number>,
): ResizeObserver {
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      wrapW.set(e.contentRect.width);
      wrapH.set(e.contentRect.height);
    }
  });
  ro.observe(el);
  wrapW.set(el.clientWidth);
  wrapH.set(el.clientHeight);
  return ro;
}

/** Focused asset's native (display-oriented) dimensions. Falls back to a
 *  3:2 frame before the decode publishes real dims. */
export function focusedImageDims(
  library: Pick<LibraryStateService, 'focusedAsset'>,
): Signal<{ w: number; h: number }> {
  return computed(() => {
    const a = library.focusedAsset();
    return { w: a?.width ?? 6240, h: a?.height ?? 4160 };
  });
}

/** A pointer event's position in `el`'s own coordinate space (CSS px). */
export function hostLocalPoint(el: HTMLElement, ev: PointerEvent): { px: number; py: number } {
  const r = el.getBoundingClientRect();
  return { px: ev.clientX - r.left, py: ev.clientY - r.top };
}
