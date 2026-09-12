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
 */
export declare class AuxBlob {
    private readonly parts;
    private total;
    add(bytes: Uint8Array): AuxRef;
    bytes(): Uint8Array;
}
