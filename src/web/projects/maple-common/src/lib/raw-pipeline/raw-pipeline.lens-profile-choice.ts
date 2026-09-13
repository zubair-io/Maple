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
import { ensureReady } from './raw-pipeline.worker-handlers';

export async function listCompatibleLensProfiles(req: LensProfileCompatibleRequest): Promise<void> {
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

export async function fetchLensProfileEvidence(req: LensProfileEvidenceRequest): Promise<void> {
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
