/// <reference lib="webworker" />
// Worker side of the bundled-Lensfun profile dropdown (#3569). Separate from
// `raw-pipeline.lens-profile.ts` (#3479's import handshake) — this is a
// read-only pair of one-shot queries: the compatible-lens list for the
// dropdown's options, and the resolver's evidence for one reference (`''` =
// automatic), both computed directly off `bytes` rather than riding a
// decode/render reply.

import { compatibleLensProfiles, resolveLensProfile } from './pkg/raw_wasm';
import {
  compatibleLensProfilesFromJson,
  lensProfileEvidenceFromJson,
} from '../lens/lens-profile-choice.metadata';
import type {
  LensProfileCompatibleRequest,
  LensProfileEvidenceRequest,
} from '../lens/lens-profile-choice.types';
import type { WorkerRequest } from './raw-pipeline.types';
import { ensureReady } from './raw-pipeline.worker-handlers';

/**
 * Dispatch entry for the two lens-profile-dropdown request kinds — read-only
 * queries computed directly off `bytes`, so they skip the legacy dispatch's
 * `'xmp' in req` sidecar-restore step. Returns whether it handled `req`, so
 * the worker's dispatch can `return` on a hit and fall through otherwise;
 * keeps this pair out of the main dispatch switch's line count (#2311).
 */
export async function tryHandleLensProfileChoiceRequest(req: WorkerRequest): Promise<boolean> {
  if (req.type === 'lens-profile-compatible') {
    await listCompatibleLensProfiles(req);
    return true;
  }
  if (req.type === 'lens-profile-evidence') {
    await fetchLensProfileEvidence(req);
    return true;
  }
  return false;
}

async function listCompatibleLensProfiles(req: LensProfileCompatibleRequest): Promise<void> {
  try {
    await ensureReady();
    const lenses = compatibleLensProfilesFromJson(
      compatibleLensProfiles(new Uint8Array(req.bytes), req.ext),
    );
    (self as unknown as Worker).postMessage({
      id: req.id,
      type: 'lens-profile-compatible-success',
      lenses,
    });
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      type: 'lens-profile-compatible-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function fetchLensProfileEvidence(req: LensProfileEvidenceRequest): Promise<void> {
  try {
    await ensureReady();
    const json = resolveLensProfile(new Uint8Array(req.bytes), req.ext, req.reference);
    const evidence = lensProfileEvidenceFromJson(json);
    if (!evidence) throw new Error('The renderer reported an unreadable lens profile match.');
    (self as unknown as Worker).postMessage({
      id: req.id,
      type: 'lens-profile-evidence-success',
      evidence,
    });
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      type: 'lens-profile-evidence-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
