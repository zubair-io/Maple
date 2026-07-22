/**
 * Authoritative list of all per-image stage names.
 *
 * The discover producer imports this to build the `stages` skeleton on every
 * new image doc. The supervisor passes it to the runtime when spawning stage
 * children. Plan 3 adds face / describe / geocode / meili here; no
 * other file needs to change.
 *
 * Order is cosmetic — the runtime enforces dependency ordering via each
 * stage's `dependsOn` array, not by position in this list.
 */

import exifStage from './exif.ts';
import thumbStage from './thumb.ts';
import previewStage from './preview.ts';
import faceDetectStage from './face-detect.ts';
import faceEmbedStage from './face-embed.ts';
import describeStage from './describe.ts';
import geocodeStage from './geocode.ts';
import meiliStage from './meili.ts';
import sidecarMetadataIndexStage from './sidecar-metadata-index.ts';
import cfThumbSyncStage from './cf-thumb-sync.ts';
import transcribeStage from './transcribe.ts';

export const stageManifest = [
  exifStage,
  thumbStage,
  previewStage,
  faceDetectStage,
  faceEmbedStage,
  describeStage,
  geocodeStage,
  meiliStage,
  sidecarMetadataIndexStage,
  cfThumbSyncStage,
  transcribeStage,
];

export const ALL_STAGE_NAMES = [
  'exif',
  'thumb',
  'preview',
  'face-detect',
  'face-embed',
  'describe',
  'geocode',
  'meili',
  'sidecar-metadata-index',
  'cf-thumb-sync',
  'transcribe',
] as const;

export type StageName = (typeof ALL_STAGE_NAMES)[number];

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
