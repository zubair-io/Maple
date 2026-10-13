/**
 * Decides how a stitch runs given the configured matcher, the provisioned ML
 * paths, and whether the binary understands `--features-engine` (#4555).
 *
 * A binary built before #4523 has no classical matcher and no flag: it can only
 * run ML, so it runs ML when both paths are provisioned and is otherwise refused
 * with a rebuild instruction rather than spawned into a guaranteed failure.
 */

import type { PanoMatcher, ResolvedPanoConfig } from './pano-config.repo.ts';

const PANO_CLI_BUILD_COMMAND =
  'cargo build --release --bin maple-cli --features pano,pano-classical';

export type PanoEnginePlan =
  | { kind: 'run'; featuresEngine: PanoMatcher | null }
  | { kind: 'refuse'; error: 'pano_ml_not_provisioned' | 'pano_cli_outdated'; message: string };

type EngineInputs = Pick<ResolvedPanoConfig, 'matcher' | 'models_dir' | 'ort_dylib_path'>;

const ML_NOT_PROVISIONED: PanoEnginePlan = {
  kind: 'refuse',
  error: 'pano_ml_not_provisioned',
  message:
    'The ML matcher is selected but its models directory or ONNX Runtime path is not set. ' +
    'Go to Settings > Pano to set both, or switch back to the classical matcher.',
};

const CLI_OUTDATED: PanoEnginePlan = {
  kind: 'refuse',
  error: 'pano_cli_outdated',
  message:
    'The configured maple-cli predates the classical matcher and can only stitch with ML, ' +
    'whose models directory and ONNX Runtime path are not both set. Rebuild maple-cli with ' +
    `\`${PANO_CLI_BUILD_COMMAND}\` (in src/raw-pipeline/), or set both ML paths in Settings > Pano.`,
};

export function planPanoEngine(
  cfg: EngineInputs,
  featuresEngineSupported: boolean,
): PanoEnginePlan {
  const mlReady = cfg.models_dir !== null && cfg.ort_dylib_path !== null;
  if (!featuresEngineSupported) {
    return mlReady ? { kind: 'run', featuresEngine: null } : CLI_OUTDATED;
  }
  if (cfg.matcher === 'classical') return { kind: 'run', featuresEngine: 'classical' };
  return mlReady ? { kind: 'run', featuresEngine: 'ml' } : ML_NOT_PROVISIONED;
}
