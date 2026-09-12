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
  /**
   * The EXIF Orientation the container's metadata declares, 1..=8, and `1`
   * when it declares none. `.rotate()`/`autoOrient` applies this.
   *
   * `undefined` for an AVIF, always — matching sharp, which reports nothing
   * for a HEIF-family file. An AVIF's `irot`/`imir` transform is applied to
   * the pixels during decode the way libheif does it, so `width`/`height`
   * are already post-transform and there is nothing left to rotate; and its
   * `Exif` item's own Orientation tag is deliberately not surfaced, since
   * libvips' own AVIF save writes the orientation into both places and
   * honouring the tag as well would rotate such a file twice. The tag is
   * still readable in the `exif` buffer.
   */
  orientation?: number;
  isRaw?: boolean;
  /**
   * The richer fields below (#3507) come from `maple_raster_analyze_buf`,
   * which only runs for an in-memory bitmap or a non-RAW bitmap file path —
   * `undefined` for a `rawInput` pixel buffer or an actual camera RAW file
   * (`.dng` etc.), which keep Tier 1's cheap header-only probe. Nothing here
   * is ever invented: a field Maple hasn't determined for the current input
   * is absent, not a guessed value.
   */
  hasAlpha?: boolean;
  hasProfile?: boolean;
  /** Colour space interpretation. Always `'srgb'` for Maple's bitmap decode. */
  space?: string;
  /**
   * Sample depth the container declares, in sharp's own vocabulary:
   * `'uchar'` for 8 bits per channel, `'ushort'` for the 16-bit samples a
   * PNG or TIFF can carry. Decoding still normalises to 8-bit; this reports
   * what the file holds.
   */
  depth?: string;
  /**
   * Pixels per inch, when the container states one — rounded to a whole
   * number, and absent at or below 25.4 dpi (libvips' 1 px/mm default),
   * both of which match sharp. A JPEG that states no resolution at all
   * reports 72, libvips' own assumption for that container.
   */
  density?: number;
  /** Byte length of the input. */
  size?: number;
  icc?: Buffer;
  exif?: Buffer;
  xmp?: Buffer;
}

export interface ChannelStats {
  min: number;
  max: number;
  sum: number;
  squaresSum: number;
  mean: number;
  stdev: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Pixel-derived statistics for every channel plus whole-image numbers (sharp's `stats()`). */
export interface ImageStats {
  channels: ChannelStats[];
  isOpaque: boolean;
  entropy: number;
  sharpness: number;
  dominant: { r: number; g: number; b: number };
}

/** sharp's `position` spellings, on top of the nine gravity names. */
export type ResizePosition =
  | 'centre'
  | 'center'
  | 'north'
  | 'northeast'
  | 'east'
  | 'southeast'
  | 'south'
  | 'southwest'
  | 'west'
  | 'northwest'
  | 'top'
  | 'right top'
  | 'right'
  | 'right bottom'
  | 'bottom'
  | 'left bottom'
  | 'left'
  | 'left top';

export type ResizeKernel =
  | 'nearest'
  | 'linear'
  | 'bilinear'
  | 'cubic'
  | 'mitchell'
  | 'lanczos2'
  | 'lanczos3';

export interface ResizeOptions {
  width?: number | null;
  height?: number | null;
  fit?: 'inside' | 'fill' | 'cover' | 'contain' | 'outside';
  /** Where the source sits inside the target box for `cover` and `contain`. Alias: `gravity`. */
  position?: ResizePosition;
  gravity?: ResizePosition;
  /** Letterbox colour for `fit: 'contain'`. */
  background?: Colour | string;
  /** sharp's name for the resampling kernel. */
  kernel?: ResizeKernel;
  /** Maple's Tier 1 name for the same option. `kernel` wins when both are set. */
  filter?: ResizeKernel;
  /** NOTE: defaults to `true` here, where sharp defaults it to `false`. */
  withoutEnlargement?: boolean;
  withoutReduction?: boolean;
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

/** Native-size pixels with whatever channel count the source carried. */
export interface RawPixelsAny {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
}

/** `{ r, g, b, alpha }`, each 0-255 for r/g/b and 0-1 for alpha. */
export type Colour = { r: number; g: number; b: number; alpha?: number };

export interface CompositeLayer {
  /** Encoded image bytes, or a raw pixel buffer. */
  input: Uint8Array | Buffer | RawPixelInput;
  left?: number;
  top?: number;
  gravity?:
    | 'centre'
    | 'center'
    | 'north'
    | 'northeast'
    | 'east'
    | 'southeast'
    | 'south'
    | 'southwest'
    | 'west'
    | 'northwest';
  blend?: 'over' | 'multiply' | 'screen' | 'add' | 'darken' | 'lighten' | 'dest-in' | 'dest-out';
  tile?: boolean;
}

export interface EncodeOptions {
  quality?: number;
  /** AVIF only: 0 (fastest) … 9 (slowest), sharp's scale. */
  effort?: number;
}

export interface ExtractRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ExtendOptions {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  /** Only `'background'` is implemented; anything else throws by name. */
  extendWith?: 'background';
  background?: Colour | string;
}

export interface RotateOptions {
  background?: Colour | string;
}

export interface TrimOptions {
  /** Defaults to the colour of the top-left pixel, as in sharp. */
  background?: Colour | string;
  threshold?: number;
  margin?: number;
  /**
   * sharp's line-art trim mode is not implemented (#3501). The type only
   * accepts `false` (its default); passing `true` throws by name at
   * execution rather than being silently ignored.
   */
  lineArt?: false;
}

export interface JpegOutputOptions {
  quality?: number;
  progressive?: boolean;
  chromaSubsampling?: '4:2:0' | '4:4:4';
  optimiseCoding?: boolean;
  optimizeCoding?: boolean;
}

export interface PngOutputOptions {
  compressionLevel?: number;
  adaptiveFiltering?: boolean;
  palette?: boolean;
  colours?: number;
  colors?: number;
  dither?: number;
}

export interface WebpOutputOptions {
  /** Must be `true`: Maple's WebP encoder is lossless-only. */
  lossless?: boolean;
}

export interface AvifOutputOptions {
  quality?: number;
  effort?: number;
  lossless?: boolean;
  chromaSubsampling?: '4:4:4' | '4:2:0';
  /**
   * Bits per channel in the AV1 bitstream: `8` (the default, matching
   * sharp's own `avif()`) or `10`. sharp's third value, `12`, is rejected by
   * name — Maple's `ravif` encoder has no 12-bit path. Note that 10-bit AVIF
   * is unreadable by libheif's prebuilt decoders (sharp included), so `8` is
   * the interoperable choice.
   */
  bitdepth?: 8 | 10;
}

export interface TiffOutputOptions {
  compression?: 'none' | 'lzw' | 'deflate' | 'packbits';
  bitdepth?: 8 | 16;
  /**
   * sharp's string form: `'horizontal'` (default) or `'none'`.
   * `'float'` is a real sharp value Maple's encoder cannot produce
   * (the `tiff` crate has no float-predictor path) and is rejected by
   * name. Forced to `'none'` regardless of this setting when the raster
   * carries alpha — see the README's parity notes.
   */
  predictor?: 'horizontal' | 'none';
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

/** `sharpen()`'s mask-based (Lab) transfer options, #3504 task E5. */
export interface SharpenOptions {
  /** Gaussian sigma, 0.000001-10. Omit for sharp's fast mild 3x3 sharpen. */
  sigma?: number;
  /** Sharpening applied to "flat" areas. Default 1.0. */
  m1?: number;
  /** Sharpening applied to "jagged" areas. Default 2.0. */
  m2?: number;
  /** Threshold between flat and jagged. Default 2.0. */
  x1?: number;
  /** Maximum brightening. Default 10.0. */
  y2?: number;
  /** Maximum darkening. Default 20.0. */
  y3?: number;
}

/** `convolve()`'s arbitrary kernel, #3504 task E5. */
export interface ConvolveKernel {
  width: number;
  height: number;
  /** `width * height` values, row-major. */
  kernel: number[];
  /**
   * Divisor for the weighted sum. Omit to use the kernel's own sum (1 for a
   * zero-sum kernel, matching sharp) — an explicit `0` is NOT the same as
   * omitting this: sharp clips any non-positive explicit `scale` up to 1.
   */
  scale?: number;
  offset?: number;
}
