/**
 * Image export functions powered by Maple core.
 */
import type { ExportImageOptions, ExportRecipeOptions, ExportResult, ThumbnailOptions } from './types';
/**
 * Render and export a single photo with optional XMP adjustments.
 */
export declare function exportImage(options: ExportImageOptions): Promise<ExportResult>;
/**
 * Render and export an image according to an ExportRecipe JSON contract.
 */
export declare function exportRecipe(options: ExportRecipeOptions): Promise<ExportResult>;
/**
 * Extract embedded RAW preview and encode to AVIF thumbnail.
 */
export declare function renderThumbnail(options: ThumbnailOptions): Promise<boolean>;
/**
 * Extract embedded RAW preview and encode to JPEG preview.
 */
export declare function renderPreview(options: ThumbnailOptions): Promise<boolean>;
