/**
 * The `edges` block of a `maple-cli pano stitch` report (#5574): what Boundary
 * Warp and Auto Crop did to the written image. Passed through to the job result
 * under the same names, with the strengths in percent as the CLI reports them.
 */

export interface PanoEdgesReport {
  output: { width: number; height: number };
  uncovered_px: number;
  boundary_warp: {
    requested: number;
    applied: number;
    /** `off`, `applied`, `clamped_fold` or a `refused_*` reason; passed through as the CLI wrote it. */
    status: string;
    max_stretch: number | null;
    min_jacobian: number | null;
    predicted_coverage: number | null;
    solve_ms: number | null;
  };
  auto_crop: {
    requested: boolean;
    rect: { x: number; y: number; width: number; height: number } | null;
    invalid_px: number | null;
  };
}

function isEdgesReport(value: unknown): value is PanoEdgesReport {
  if (typeof value !== 'object' || value === null) return false;
  const { boundary_warp: warp, auto_crop: crop } = value as Record<string, unknown>;
  return (
    typeof warp === 'object' &&
    warp !== null &&
    typeof (warp as Record<string, unknown>).status === 'string' &&
    typeof crop === 'object' &&
    crop !== null
  );
}

/** Null when the report is missing, unreadable or from a binary without edges. */
export async function readEdgesReport(reportFile: string): Promise<PanoEdgesReport | null> {
  const report = await Bun.file(reportFile)
    .json()
    .then((parsed) => parsed as { edges?: unknown })
    .catch(() => null);
  return isEdgesReport(report?.edges) ? report.edges : null;
}
