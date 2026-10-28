/**
 * Decides how a stitch runs given the configured matcher, the provisioned ML
 * paths, and whether the binary understands `--features-engine` (#4555).
 *
 * An ML matcher whose models directory or ONNX Runtime path is not set runs
 * the classical matcher instead (#5487) and says so in `matcherNote`, which
 * the job result carries to the UI; a configured path that no longer exists
 * counts as unset (`withExistingMlPaths`). A binary built before #4523 has no
 * classical matcher to fall back to and no flag: it runs ML when both paths
 * are provisioned and is otherwise refused rather than spawned into a
 * guaranteed failure.
 */

import { access } from '../fs/mirrored.ts';
import type { PanoMatcher, ResolvedPanoConfig } from './pano-config.repo.ts';

export type PanoEnginePlan =
  | { kind: 'run'; featuresEngine: PanoMatcher | null; matcherNote: string | null }
  | { kind: 'refuse'; error: 'pano_cli_outdated'; message: string };

type EngineInputs = Pick<ResolvedPanoConfig, 'matcher' | 'models_dir' | 'ort_dylib_path'>;

export const ML_FALLBACK_NOTE =
  'Used the classical matcher because the ML matcher’s models aren’t installed on the server.';

const CLI_OUTDATED: PanoEnginePlan = {
  kind: 'refuse',
  error: 'pano_cli_outdated',
  message:
    'The server’s panorama tool is out of date and needs the ML matcher, which isn’t set up. ' +
    'Update the panorama tool on the server, or set up the ML matcher in Settings > Pano.',
};

export function planPanoEngine(
  cfg: EngineInputs,
  featuresEngineSupported: boolean,
): PanoEnginePlan {
  const mlReady = cfg.models_dir !== null && cfg.ort_dylib_path !== null;
  if (!featuresEngineSupported) {
    return mlReady ? { kind: 'run', featuresEngine: null, matcherNote: null } : CLI_OUTDATED;
  }
  if (cfg.matcher === 'ml' && mlReady) {
    return { kind: 'run', featuresEngine: 'ml', matcherNote: null };
  }
  const matcherNote = cfg.matcher === 'ml' ? ML_FALLBACK_NOTE : null;
  return { kind: 'run', featuresEngine: 'classical', matcherNote };
}

const exists = (p: string | null): Promise<boolean> =>
  p === null
    ? Promise.resolve(false)
    : access(p).then(
        () => true,
        () => false,
      );

/** `cfg` with any ML path that is not on disk cleared, so it plans as unset. */
export async function withExistingMlPaths<C extends EngineInputs>(cfg: C): Promise<C> {
  const [modelsFound, ortFound] = await Promise.all([
    exists(cfg.models_dir),
    exists(cfg.ort_dylib_path),
  ]);
  return {
    ...cfg,
    models_dir: modelsFound ? cfg.models_dir : null,
    ort_dylib_path: ortFound ? cfg.ort_dylib_path : null,
  };
}
