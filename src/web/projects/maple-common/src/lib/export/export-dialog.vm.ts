// View-model helpers for the export dialog (#943).
//
// Pure functions and constant tables — no Angular, no services — so the
// component holds only signals and the naming / sizing rules are unit-testable
// on their own.

import type { ExportColorSpace, ExportFormat } from '../raw-pipeline/raw-pipeline.types';

/** A selectable output format, with the copy shown next to it. */
export interface FormatChoice {
  readonly value: ExportFormat;
  readonly label: string;
  readonly detail: string;
}

/**
 * The formats offered, in the order they appear. JPEG leads because it is the
 * everyday deliverable; TIFF is the hand-off master.
 */
export const FORMAT_CHOICES: readonly FormatChoice[] = [
  { value: 'jpeg', label: 'JPEG', detail: '8-bit, compressed — for sharing and the web.' },
  { value: 'tiff', label: 'TIFF', detail: '16-bit, lossless — the master for further grading.' },
  {
    value: 'png',
    label: 'PNG',
    detail: '8-bit, lossless — larger files, no compression artefacts.',
  },
];

/** A selectable output colour space. */
export interface ColorSpaceChoice {
  readonly value: ExportColorSpace;
  readonly label: string;
  readonly detail: string;
}

export const COLOR_SPACE_CHOICES: readonly ColorSpaceChoice[] = [
  { value: 'srgb', label: 'sRGB', detail: 'Safest everywhere — the web, email, most printers.' },
  {
    value: 'display-p3',
    label: 'Display P3',
    detail: 'Wider gamut — keeps saturation sRGB cannot express.',
  },
];

/** Long-edge presets offered alongside "Full resolution". */
export const SIZE_PRESETS: readonly number[] = [4096, 2560, 2048, 1024];

/** Default JPEG quality. Matches the pipeline spec's §04 default. */
export const DEFAULT_QUALITY = 92;

/** Only JPEG has a quality control; the others are lossless. */
export function supportsQuality(format: ExportFormat): boolean {
  return format === 'jpeg';
}

/**
 * Strip any directory prefix and the extension from an asset filename.
 *
 * Asset filenames are usually a bare basename but the self-hosted address form
 * can carry a path, so the split is defensive — the same reasoning as
 * `EditorShellComponent.assetName`.
 */
export function baseName(filename: string): string {
  const segments = filename.split('/');
  const last = segments[segments.length - 1] ?? filename;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/** The filename an export is offered to the browser under. */
export function exportFilename(assetFilename: string, extension: string): string {
  return `${baseName(assetFilename)}.${extension}`;
}

/**
 * The dimensions an export will actually produce.
 *
 * `maxSidePixels` caps the LONG edge and never upscales, matching the
 * pipeline's contract — so a cap at or above the native long edge is a no-op
 * and the preview must say so rather than promising an upscale.
 */
export function outputDimensions(
  nativeWidth: number,
  nativeHeight: number,
  maxSidePixels: number | undefined,
): { width: number; height: number } {
  const longEdge = Math.max(nativeWidth, nativeHeight);
  if (!maxSidePixels || maxSidePixels <= 0 || maxSidePixels >= longEdge || longEdge === 0) {
    return { width: nativeWidth, height: nativeHeight };
  }
  const scale = maxSidePixels / longEdge;
  return {
    width: Math.max(1, Math.round(nativeWidth * scale)),
    height: Math.max(1, Math.round(nativeHeight * scale)),
  };
}
