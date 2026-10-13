// Stage labels for pano job progress (#4580). The server reports 100 units per
// stage across the stitch's six stage ordinals, parsed from maple-cli's
// `pano: progress <stage> <fraction>` lines; a preview walks the same stages,
// skipping refinement.

import type { PanoJobProgress } from '../api/pano.service';

const STAGE_LABELS = [
  'Decoding frames',
  'Detecting features',
  'Matching frames',
  'Refining matches',
  'Solving alignment',
  'Compositing',
] as const;

export function panoProgressFraction(progress: PanoJobProgress | null | undefined): number | null {
  return progress && progress.total > 0
    ? Math.min(Math.max(progress.current / progress.total, 0), 1)
    : null;
}

export function panoProgressLabel(progress: PanoJobProgress | null | undefined): string {
  const fraction = panoProgressFraction(progress);
  if (fraction === null) return 'Starting…';
  const stage = Math.min(Math.floor(fraction * STAGE_LABELS.length), STAGE_LABELS.length - 1);
  return `${STAGE_LABELS[stage]} · ${Math.round(fraction * 100)}%`;
}
