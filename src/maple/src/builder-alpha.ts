/**
 * Alpha-channel op builders for `MapleImageBuilder` — composite, flatten,
 * ensureAlpha, removeAlpha (#3505, Tier 2 PR-A), emitting the recipe ops
 * `raster_composite.rs`/`raster_alpha.rs` implement. Split out of
 * `builder.ts` to keep that file under the repo's file-size budget: same
 * pattern `builder-geometry.ts`/`builder-colour.ts`/`builder-filter.ts` use
 * — each function mutates one `BuilderState` in place, and the builder's
 * own methods are thin wrappers that call these and return `this`.
 */

import type { BuilderState } from './builder-state';
import { resolveColour } from './builder-state';
import type { Colour, CompositeLayer } from './types';

const OPAQUE_BLACK: [number, number, number, number] = [0, 0, 0, 255];

/** Composite overlay image(s) over the processed image (sharp's `composite`). */
export function pushComposite(state: BuilderState, layers: CompositeLayer[]): void {
  const wire = layers.map((layer) => {
    if ((layer.left === undefined) !== (layer.top === undefined)) {
      throw new Error('composite: a layer must set both left and top, or neither');
    }
    const raw =
      'data' in layer.input
        ? {
            width: layer.input.width,
            height: layer.input.height,
            channels: layer.input.channels,
          }
        : null;
    const bytes = 'data' in layer.input ? layer.input.data : layer.input;
    return {
      aux: state.aux.add(bytes),
      raw,
      left: layer.left ?? null,
      top: layer.top ?? null,
      gravity: layer.gravity ?? 'centre',
      blend: layer.blend ?? 'over',
      tile: layer.tile ?? false,
    };
  });
  state.ops.push({ op: 'composite', layers: wire });
}

/** Merge the alpha channel with a background and drop it. */
export function pushFlatten(state: BuilderState, options?: { background?: Colour | string }): void {
  state.ops.push({
    op: 'flatten',
    background: resolveColour(options?.background, OPAQUE_BLACK),
  });
}

/** Ensure the image has an alpha channel, filled with `alpha` (0-1). */
export function pushEnsureAlpha(state: BuilderState, alpha = 1): void {
  state.ops.push({ op: 'ensureAlpha', alpha: Math.max(0, Math.min(1, alpha)) });
}

/** Drop the alpha channel without compositing. */
export function pushRemoveAlpha(state: BuilderState): void {
  state.ops.push({ op: 'removeAlpha' });
}
