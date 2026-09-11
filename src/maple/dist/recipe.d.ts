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
export interface Recipe {
    v: 1;
    input: RecipeInput;
    ops: RecipeOp[];
    output: Record<string, unknown>;
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
