/**
 * Types for the Maple image processing package.
 */

export type ExportFormat = 'jpeg' | 'tiff' | 'png' | 'avif' | 'webp';
export type ExportColorSpace = 'srgb' | 'display-p3';

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  channels: number;
  orientation: number;
  isRaw?: boolean;
}

export interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: 'inside' | 'fill' | 'cover';
  withoutEnlargement?: boolean;
  filter?: 'lanczos3' | 'bilinear' | 'nearest';
}

export interface RawPixelInput {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

export interface RawPixels {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 3;
}

export interface EncodeOptions {
  quality?: number;
  /** AVIF only: 0 (fastest) … 9 (slowest), sharp's scale. */
  effort?: number;
}

export interface TensorOptions {
  targetSize?: number;
  layout?: 'nchw' | 'hwc';
  normalize?: 'none' | 'insightface' | 'zeroToOne';
}

export interface TensorResult {
  data: Float32Array;
  width: number;
  height: number;
  channels: number;
}

export interface ExportImageOptions {
  /** Path to source RAW file */
  rawPath: string;
  /** Path to output file */
  outPath: string;
  /** Optional path to XMP sidecar containing adjustments */
  xmpPath?: string | null;
  /** Export container format. Default 'jpeg' */
  format?: ExportFormat;
  /** Quality 1..100 (for lossy JPEG). Default 92 */
  quality?: number;
  /** Output color primaries and ICC profile. Default 'srgb' */
  colorSpace?: ExportColorSpace;
  /** Long-edge downscale cap in pixels. 0 or undefined for full resolution */
  maxLongEdge?: number;
}

export interface ExportRecipe {
  readonly schemaVersion: number;
  readonly name: string;
  readonly format: string;
  readonly quality: number | null;
  readonly bitDepth: number;
  readonly maxLongEdge: number | null;
  readonly outputProfile: string;
  readonly renderingIntent: string;
  readonly metadataPolicy: string;
  readonly namingTemplate: string;
  readonly destination: string;
  readonly directory: string | null;
  readonly watermark: string | null;
  readonly overwritePolicy: string;
}

export interface ExportRecipeOptions {
  /** Path to source RAW file */
  rawPath: string;
  /** Raw XML content of XMP sidecar */
  xmpXml?: string;
  /** ExportRecipe object or serialized JSON string */
  recipe: ExportRecipe | string;
  /** Path to film LUTs directory (if a film look is used) */
  filmPath?: string | null;
  /** Path to write the output image file */
  outPath: string;
}

export interface ExportResult {
  ok: boolean;
  outPath: string;
  error?: string;
}

export interface ThumbnailOptions {
  rawPath: string;
  outPath: string;
  maxPx?: number;
  quality?: number;
}

export interface FilenameTemplateArgs {
  template: string;
  originalStem: string;
  ext: string;
  capturedAt: string | null;
  sequenceStart: number;
  sequenceIndex: number;
  sequencePadWidth: number;
}

export type FilenameResult =
  | { ok: true; name: string }
  | { ok: false; code: number; error: string };
