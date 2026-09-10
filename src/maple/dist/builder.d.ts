/**
 * Fluent builder API for Maple image operations.
 *
 * Provides a unified chaining interface for RAW photo development,
 * non-RAW bitmap SIMD resizing, in-memory transcoding, and AI tensor extraction.
 */
import type { ExportColorSpace, ExportFormat, ExportRecipe, ExportResult, ImageMetadata, ResizeOptions, TensorOptions, TensorResult } from './types';
export declare function isRawPath(filePath: string): boolean;
export declare class MapleImageBuilder {
    private _inputPath;
    private _inputBytes;
    private _xmpPath;
    private _xmpXml;
    private _format;
    private _quality;
    private _colorSpace;
    private _maxLongEdge;
    private _filmPath;
    private _recipe;
    private _resizeWidth;
    private _resizeHeight;
    private _resizeFit;
    private _withoutEnlargement;
    private _autoOrient;
    private _removeAlpha;
    constructor(input: string | Uint8Array | Buffer);
    /** Specify path to XMP sidecar */
    xmp(xmpPath: string): this;
    /** Apply raw XML content of XMP sidecar */
    applyXmp(xml: string): this;
    /** Specify raw XML content of XMP sidecar (alias for applyXmp) */
    xmpContent(xml: string): this;
    /** Configure SIMD resampling dimensions and framing */
    resize(optionsOrWidth: ResizeOptions | number, height?: number): this;
    /** Automatically rotate according to EXIF orientation */
    rotate(): this;
    /** Set output container format and optional quality */
    toFormat(format: ExportFormat, options?: {
        quality?: number;
    }): this;
    /** Set output container format */
    format(format: ExportFormat): this;
    /** Set output quality (1..100) */
    quality(quality: number): this;
    /** Set target primaries / ICC profile */
    colorSpace(space: ExportColorSpace): this;
    /** Target colourspace (alias for colorSpace) */
    toColourspace(space: string): this;
    /** Strip alpha channel from image output */
    removeAlpha(): this;
    /** Set maximum long edge cap */
    maxLongEdge(px: number): this;
    /** Set film LUTs directory */
    filmPath(dir: string): this;
    /** Use a saved ExportRecipe */
    recipe(recipe: ExportRecipe | string): this;
    /** Use a saved ExportRecipe (alias) */
    exportRecipe(recipe: ExportRecipe | string): this;
    /** Inspect image dimensions, format, orientation without full decode */
    metadata(): Promise<ImageMetadata>;
    /** Check if image file or buffer is valid and uncorrupted by decoding payload */
    validateIntegrity(): Promise<boolean>;
    /** Normalize image orientation in-place on disk */
    normalizeOrientationInPlace(): Promise<boolean>;
    /** Extract raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace) */
    toRawRgb(options?: TensorOptions): Promise<TensorResult>;
    /** Render or resize image directly to an in-memory Buffer */
    toBuffer(): Promise<Buffer>;
    /** Execute export or resize and write to output file */
    toFile(outputPath: string): Promise<ExportResult>;
}
/**
 * Entry function to create a Maple image operation.
 */
export declare function maple(input: string | Uint8Array | Buffer): MapleImageBuilder;
