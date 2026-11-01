// What to tell the user about Boundary Warp once the engine has reported
// (docs/design/maple-ui/components/slider.md § States, "Helper, warning"; copy
// from epic #5570). The report's strengths are percents, the slider's own scale.

export const BOUNDARY_WARP_HELP = 'Stretches the edges toward a full rectangle.';
export const AUTO_CROP_HELP = 'Crops to the largest rectangle with no empty edges.';

export interface PanoBoundaryWarpReport {
  boundary_warp: { applied: number; status: string };
}

const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  refused_disconnected:
    'Not applied: the frames form separate pieces, so the edges stay as stitched.',
  refused_full_wrap: 'Not applied to 360° panoramas. Auto Crop can still trim the top and bottom.',
  refused_fold: 'Not applied: warping this shape would fold the image.',
  refused_empty: 'Not applied: there are no stitched pixels to warp.',
  refused_shape:
    "Not applied: this panorama's outline can't be warped, so the edges stay as stitched.",
  refused_solve:
    "Not applied: the warp couldn't be computed for this panorama, so the edges stay as stitched.",
};

/** The reason line for a report, or null when the warp took effect as asked or the status is not one this build knows. */
export function panoBoundaryWarpReason(
  report: PanoBoundaryWarpReport | null | undefined,
): string | null {
  const warp = report?.boundary_warp;
  if (!warp) return null;
  return warp.status === 'clamped_fold'
    ? `Limited to ${Math.round(warp.applied)}% so the image doesn't fold.`
    : (REFUSAL_REASONS[warp.status] ?? null);
}
