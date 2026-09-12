/**
 * Fluent builder API for Maple image operations.
 *
 * Provides a unified chaining interface for RAW photo development,
 * non-RAW bitmap SIMD resizing, in-memory transcoding, and AI tensor extraction.
 */
import type { AvifOutputOptions, Colour, CompositeLayer, EncodeOptions, ExportColorSpace, ExportFormat, ExportRecipe, ExportResult, ImageMetadata, JpegOutputOptions, PngOutputOptions, RawPixelInput, RawPixels, RawPixelsAny, ResizeOptions, TensorOptions, TensorResult, TiffOutputOptions, WebpOutputOptions } from './types';
export declare class MapleImageBuilder {
    private readonly s;
    constructor(input: string | Uint8Array | Buffer | RawPixelInput);
    /** Specify path to XMP sidecar */
    xmp(xmpPath: string): this;
    /** Apply raw XML content of XMP sidecar */
    applyXmp(xml: string): this;
    /** Specify raw XML content of XMP sidecar (alias for applyXmp) */
    xmpContent(xml: string): this;
    /** Configure SIMD resampling dimensions and framing */
    resize(optionsOrWidth: ResizeOptions | number | null, height?: number | null): this;
    /** Automatically rotate according to EXIF orientation */
    rotate(): this;
    /**
     * Set output container format and optional quality/effort.
     *
     * Naming a different container than an earlier `.jpeg()`/`.png()`/… call
     * discards that call's options — see `applyFormat`.
     */
    toFormat(format: ExportFormat, options?: EncodeOptions): this;
    /** Encode as JPEG with sharp's options. */
    jpeg(options?: JpegOutputOptions): this;
    /** Encode as PNG with sharp's options. */
    png(options?: PngOutputOptions): this;
    /** Encode as lossless WebP. `{ lossless: false }` throws — see the README. */
    webp(options?: WebpOutputOptions): this;
    /** Encode as AVIF with sharp's options. */
    avif(options?: AvifOutputOptions): this;
    /** Encode as TIFF with sharp's options. */
    tiff(options?: TiffOutputOptions): this;
    /** Set output container format */
    format(format: ExportFormat): this;
    /**
     * Set output quality (1..100). Reaches an earlier `.jpeg()`/`.avif()`
     * call's output too; PNG, WebP and TIFF have no quality knob in Maple's
     * encoders, so there is nothing for it to change there.
     *
     * Last call wins, in both directions: `.quality(30).jpeg()` encodes at
     * `.jpeg()`'s own default of 80 (the per-format call is the later, more
     * specific instruction), while `.jpeg().quality(30)` encodes at 30.
     */
    quality(quality: number): this;
    /** Set target primaries / ICC profile */
    colorSpace(space: ExportColorSpace): this;
    /** Target colourspace (alias for colorSpace) */
    toColourspace(space: string): this;
    /** Set maximum long edge cap */
    maxLongEdge(px: number): this;
    /** Set film LUTs directory */
    filmPath(dir: string): this;
    /** Use a saved ExportRecipe */
    recipe(recipe: ExportRecipe | string): this;
    /** Use a saved ExportRecipe (alias) */
    exportRecipe(recipe: ExportRecipe | string): this;
    /** Composite overlay image(s) over the processed image (sharp's `composite`). */
    composite(layers: CompositeLayer[]): this;
    /** Merge the alpha channel with a background and drop it. */
    flatten(options?: {
        background?: Colour | string;
    }): this;
    /** Ensure the image has an alpha channel, filled with `alpha` (0-1). */
    ensureAlpha(alpha?: number): this;
    /** Drop the alpha channel without compositing. */
    removeAlpha(): this;
    /** Native-size interleaved pixels, alpha preserved when the source has it. */
    toRawAlpha(): Promise<RawPixelsAny>;
    /** Inspect image dimensions, format, orientation without full decode */
    metadata(): Promise<ImageMetadata>;
    /** Check if image file or buffer is valid and uncorrupted by decoding payload */
    validateIntegrity(): Promise<boolean>;
    /** Normalize image orientation in-place on disk */
    normalizeOrientationInPlace(): Promise<boolean>;
    /** Extract raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace) */
    toRawRgb(options?: TensorOptions): Promise<TensorResult>;
    /**
     * True when this builder describes a RAW develop rather than a bitmap
     * transform: a recipe, an XMP sidecar, or a RAW file path as input.
     */
    private isRawDevelop;
    /** Saved-recipe or XMP-driven RAW development, rendered to a tmp file and read back. */
    private rawDevelopToBuffer;
    /** Saved-recipe or XMP-driven RAW development, written straight to `outputPath`. */
    private rawDevelopToFile;
    /** Render or resize image directly to an in-memory Buffer */
    toBuffer(): Promise<Buffer>;
    /** Execute export or resize and write to output file */
    toFile(outputPath: string): Promise<ExportResult>;
    /** Decode to native-size interleaved RGB8 (alpha dropped, grey expanded). */
    toRaw(): Promise<RawPixels>;
}
/**
 * Entry function to create a Maple image operation.
 */
export declare function maple(input: string | Uint8Array | Buffer | RawPixelInput): MapleImageBuilder;
