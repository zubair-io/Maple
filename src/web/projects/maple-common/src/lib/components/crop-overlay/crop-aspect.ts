// crop-aspect.ts — aspect-ratio presets for the crop tool (#638). `ratio` is
// image-space width:height; `null` means a free (unconstrained) crop, and
// `'original'` resolves to the source image's own aspect at apply time.

export type AspectId =
  | 'free'
  | 'original'
  | 'square'
  | '3:2'
  | '4:3'
  | '16:9'
  | '2:3'
  | '3:4'
  | '9:16';

export interface AspectPreset {
  id: AspectId;
  label: string;
  /** Image-space width / height; `null` = free, `'original'` = source aspect. */
  ratio: number | null | 'original';
}

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: 'square', label: '1:1', ratio: 1 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
];

/** Resolve a preset to a concrete image-space aspect (width / height), or
 *  `null` for a free crop. `imgW`/`imgH` resolve the `'original'` preset. */
export function resolveAspect(preset: AspectPreset, imgW: number, imgH: number): number | null {
  if (preset.ratio === null) return null;
  if (preset.ratio === 'original') return imgH > 0 ? imgW / imgH : null;
  return preset.ratio;
}
