/**
 * TypeScript mirror of the raster recipe schema
 * (`raw-pipeline/raw-core/src/raster_recipe.rs`). The builder accumulates
 * `RecipeOp`s and one `AuxBlob`; `stateToRecipe` turns them into the JSON the
 * FFI takes.
 */
export interface AuxRef {
    off: number;
    len: number;
}
export interface RecipeOp {
    op: string;
    [key: string]: unknown;
}
export type RecipeInput = {
    kind: 'encoded';
} | {
    kind: 'raw';
    width: number;
    height: number;
    channels: number;
};
/**
 * What to do with the input's own EXIF/ICC/XMP, and what EXIF Orientation to
 * write (#3507). Mirrors `raw-core/src/raster_recipe_meta.rs::RecipeMetadata`
 * field-for-field. `keep: false` (the default) strips everything, matching
 * sharp's own default; caller-supplied `exif`/`icc`/`xmp` (via `aux`) win
 * over `keep`.
 */
export interface RecipeMetadata {
    keep: boolean;
    orientation?: number;
    density?: number;
    exif?: AuxRef;
    icc?: AuxRef;
    /**
     * A named built-in profile instead of `icc` bytes, resolved on the Rust
     * side via `icc::profile_for` so the package never ships a copy of them
     * (#3507 fix-round-1, item 2). Ignored when `icc` is also set.
     *
     * The wire still accepts `'p3'`, which the Rust side resolves; the
     * builder's own `withIccProfile('p3')` refuses, because tagging without
     * converting would mislabel sRGB pixels (#3507 final fix wave, item 10).
     * A recipe written by hand can therefore still ask for it deliberately.
     */
    iccName?: 'srgb' | 'p3';
    xmp?: AuxRef;
}
export interface Recipe {
    v: 1;
    input: RecipeInput;
    ops: RecipeOp[];
    output: Record<string, unknown>;
    metadata: RecipeMetadata;
}
/**
 * Flat side-car buffer for everything binary a recipe references — composite
 * overlay pixels, a supplied ICC profile, an EXIF or XMP block. Segments are
 * appended in call order and addressed by `{ off, len }`.
 *
 * A segment may be registered as a pending loader (`addPending`) rather than
 * bytes in hand, for a fluent setter that only has a *source* for the bytes
 * (a file path) at call time — this keeps that setter itself synchronous,
 * matching every other `with*` method, while the actual read waits for
 * `resolve()`. `off`/`len` on a pending segment's `AuxRef` are meaningless
 * until `resolve()` runs, because they depend on the byte lengths of every
 * OTHER segment too (some possibly still pending) — the object is mutated in
 * place once real lengths are known, which is why every caller that stashes
 * a ref (`state.metadata.icc`, an op's `aux` field, …) sees the final offset
 * without having to re-fetch anything.
 */
export declare class AuxBlob {
    private readonly parts;
    private resolving;
    add(bytes: Uint8Array): AuxRef;
    /** Drop superseded metadata before its pending file is opened. */
    discard(ref: AuxRef | undefined): void;
    /** Reserve a segment whose bytes are read lazily, once, inside `resolve()`. */
    addPending(loader: () => Promise<Uint8Array>): AuxRef;
    /**
     * Run every pending loader and fix up every segment's `off`/`len` in call
     * order. Must complete before `bytes()` is called; safe to call with no
     * pending segments at all (the common case), and idempotent — a loader
     * that already ran is not re-run.
     */
    resolve(): Promise<void>;
    private resolveParts;
    bytes(): Uint8Array;
}
