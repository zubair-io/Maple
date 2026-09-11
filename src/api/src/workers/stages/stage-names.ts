/**
 * The canonical list of per-asset claim stages — a dependency-free leaf so
 * `db/client.ts` (index creation) and the stage manifest share ONE source of
 * truth. A second hand-written copy of this list is exactly how four stages
 * ended up without claim indexes and scanned the whole collection on every
 * `/status` call (#3491). Add a stage here and to `manifest.ts` together.
 */
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
  'video-describe',
] as const;

export type StageName = (typeof ALL_STAGE_NAMES)[number];
