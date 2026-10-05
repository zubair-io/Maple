import type { LibraryStateService } from '../../state/library-state.service';
import type { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';

/** Show actual focused-asset network progress; cached/local decode has no bar. */
export function canvasDownloadProgress(
  p: ReturnType<LibraryStateService['openDownloadProgress']>,
  a: ReturnType<LibraryStateService['focusedAsset']>,
) {
  if (!p || !a || p.id !== a.id) return null;
  const pct = p.total && p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null;
  return { loaded: p.loaded, total: p.total, pct };
}

/** BM3D reports real completion across both passes, never simulated progress. */
export function canvasDeepDenoiseProgress(
  pipeline: Pick<RawPipelineService, 'deepDenoiseProgress'>,
) {
  const p = pipeline.deepDenoiseProgress();
  if (!p) return null;
  return { pass: p.pass, pct: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100) };
}
