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
import type { Colour, CompositeLayer } from './types';
/** Composite overlay image(s) over the processed image (sharp's `composite`). */
export declare function pushComposite(state: BuilderState, layers: CompositeLayer[]): void;
/** Merge the alpha channel with a background and drop it. */
export declare function pushFlatten(state: BuilderState, options?: {
    background?: Colour | string;
}): void;
/** Ensure the image has an alpha channel, filled with `alpha` (0-1). */
export declare function pushEnsureAlpha(state: BuilderState, alpha?: number): void;
/** Drop the alpha channel without compositing. */
export declare function pushRemoveAlpha(state: BuilderState): void;
