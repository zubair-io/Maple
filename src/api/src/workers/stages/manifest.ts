/**
 * Definitions and starters for every canonical per-image stage.
 *
 * The discover producer imports this to build the `stages` skeleton on every
 * new image doc. The orchestrator uses these same registrations to pre-register
 * and boot runners. The dependency-free stage-names.ts remains safe for DB bootstrap.
 *
 * Order is cosmetic — the runtime enforces dependency ordering via each
 * stage's `dependsOn` array, not by position in this list.
 */

import exifStage, { startExifStage } from './exif.ts';
import thumbStage, { startThumbStage } from './thumb.ts';
import previewStage, { startPreviewStage } from './preview.ts';
import faceDetectStage, { startFaceDetectStage } from './face-detect.ts';
import faceEmbedStage, { startFaceEmbedStage } from './face-embed.ts';
import describeStage, { startDescribeStage } from './describe.ts';
import geocodeStage, { startGeocodeStage } from './geocode.ts';
import meiliStage, { startMeiliStage } from './meili.ts';
import sidecarMetadataIndexStage, {
  startSidecarMetadataIndexStage,
} from './sidecar-metadata-index.ts';
import cfThumbSyncStage, { startCfThumbSyncStage } from './cf-thumb-sync.ts';
import transcribeStage, { startTranscribeStage } from './transcribe.ts';
import videoDescribeStage, { startVideoDescribeStage } from './video-describe.ts';
import type { RunStageHandle, StageConfig } from '../run-stage.ts';
import { ALL_STAGE_NAMES, assertCompleteStageNames, type StageName } from './stage-names.ts';

/** Definitions and starters are registered together; every canonical name is required. */
export const stageRegistrations = {
  exif: { definition: exifStage, start: startExifStage },
  thumb: { definition: thumbStage, start: startThumbStage },
  preview: { definition: previewStage, start: startPreviewStage },
  'face-detect': { definition: faceDetectStage, start: startFaceDetectStage },
  'face-embed': { definition: faceEmbedStage, start: startFaceEmbedStage },
  describe: { definition: describeStage, start: startDescribeStage },
  geocode: { definition: geocodeStage, start: startGeocodeStage },
  meili: { definition: meiliStage, start: startMeiliStage },
  'sidecar-metadata-index': {
    definition: sidecarMetadataIndexStage,
    start: startSidecarMetadataIndexStage,
  },
  'cf-thumb-sync': { definition: cfThumbSyncStage, start: startCfThumbSyncStage },
  transcribe: { definition: transcribeStage, start: startTranscribeStage },
  'video-describe': { definition: videoDescribeStage, start: startVideoDescribeStage },
} satisfies Record<StageName, { definition: StageConfig; start: () => Promise<RunStageHandle> }>;

export const stageManifest = ALL_STAGE_NAMES.map((name) => stageRegistrations[name].definition);
assertCompleteStageNames(stageManifest.map((stage) => stage.name));

export { ALL_STAGE_NAMES, type StageName } from './stage-names.ts';

/**
 * Build the blank `stages` skeleton that discover writes on every new image doc.
 * Every field starts at `version: 0` so all wired controllers immediately
 * see the doc as needing work.
 */
export function blankStagesSkeleton(): Record<
  StageName,
  {
    version: number;
    attempts: number;
    last_error: null;
    processed_at: null;
    dead: boolean;
  }
> {
  const entry = {
    version: 0,
    attempts: 0,
    last_error: null,
    processed_at: null,
    dead: false,
  };
  return Object.fromEntries(ALL_STAGE_NAMES.map((name) => [name, { ...entry }])) as ReturnType<
    typeof blankStagesSkeleton
  >;
}
