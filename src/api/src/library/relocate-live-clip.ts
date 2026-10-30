import { listDirectoryLivePhotoCandidates } from '../db/repos/assets.address.ts';
import { findRelocateCandidatesByFilenames } from '../db/repos/assets.by-filename.ts';
import type { ObjectId } from '../db/object-id.ts';
import type { AssetWithId, FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { SIDECAR_METADATA_INDEX_STAGE_NAME } from '../workers/stages/sidecar-metadata-index.ts';
import { pairLivePhotos } from './live-photo-pairs.ts';
import { relocateGeoAsset } from './relocate-geo.ts';

const log = childLogger('library/relocate-live-clip');

export interface RelocationMember {
  id: string;
  primary: FileInfo;
}

/** The catalog location of a still's clip, beside the still. */
export interface PlannedClip {
  assetId: string;
  libraryId: ObjectId;
  path: string;
  filename: string;
}

/** Which of a batch's assets are the clip half of a Live Photo, and which clip each still brings along. */
export interface LiveClipPlan {
  followerClipIds: ReadonlySet<string>;
  clipByStillId: ReadonlyMap<string, PlannedClip>;
}

/** A planned clip with its asset and the location beside the still, which need not be its first. */
export interface LoadedClip {
  doc: AssetWithId;
  location: FileInfo;
}

type PlannedLink =
  | { role: 'clip'; clipId: string }
  | { role: 'still'; stillId: string; clip: PlannedClip };

export type ClipMoveResult = { ok: true } | { ok: false; error: string };

/**
 * Pair each member's folder by Apple content identifier and sort the batch into
 * stills that bring a clip along and clips that only ever follow their still.
 * Only identifier-paired files are linked; a same-stem clip with another or no
 * identifier is an ordinary asset.
 */
export async function planLiveClips(members: readonly RelocationMember[]): Promise<LiveClipPlan> {
  const folders = Map.groupBy(
    members,
    (member) => `${member.primary.library_id.toHexString()}\0${member.primary.path}`,
  );
  const planned = await Promise.all(
    [...folders.values()].map(async (folderMembers) => {
      const [{ primary }] = folderMembers as [RelocationMember, ...RelocationMember[]];
      const candidates = await listDirectoryLivePhotoCandidates(primary.library_id, primary.path);
      const idByFilename = new Map(
        candidates.map((candidate) => [candidate.filename, candidate.id]),
      );
      const links = pairLivePhotos(candidates);
      return folderMembers.flatMap((member): readonly PlannedLink[] => {
        const link = links.get(member.primary.filename);
        const clipId = link && idByFilename.get(link.partner);
        if (!link || clipId === undefined) return [];
        return link.role === 'clip'
          ? [{ role: 'clip', clipId: member.id }]
          : [
              {
                role: 'still',
                stillId: member.id,
                clip: {
                  assetId: clipId,
                  libraryId: primary.library_id,
                  path: primary.path,
                  filename: link.partner,
                },
              },
            ];
      });
    }),
  );
  const links = planned.flat();
  return {
    followerClipIds: new Set(links.flatMap((link) => (link.role === 'clip' ? [link.clipId] : []))),
    clipByStillId: new Map(
      links.flatMap((link) => (link.role === 'still' ? [[link.stillId, link.clip] as const] : [])),
    ),
  };
}

/**
 * Load each planned clip by asset id and pick the location the pairing found,
 * rather than the clip's first active location: a clip with several copies is
 * paired through the one that sits beside the still.
 */
export async function loadPlannedClips(
  plan: LiveClipPlan,
): Promise<ReadonlyMap<string, LoadedClip>> {
  const planned = [...plan.clipByStillId.entries()];
  if (planned.length === 0) return new Map();
  const candidates = await findRelocateCandidatesByFilenames(
    [...new Set(planned.map(([, clip]) => clip.filename))],
    SIDECAR_METADATA_INDEX_STAGE_NAME,
  );
  const docById = new Map(candidates.map(({ doc }) => [doc._id.toHexString(), doc]));
  return new Map(
    planned.flatMap(([stillId, clip]) => {
      const doc = docById.get(clip.assetId);
      const location = doc?.fileinfo?.find(
        (entry) =>
          !entry.deleted_at &&
          entry.library_id.toHexString() === clip.libraryId.toHexString() &&
          entry.path === clip.path &&
          entry.filename === clip.filename,
      );
      return doc && location ? [[stillId, { doc, location }] as const] : [];
    }),
  );
}

/**
 * Move a still's paired clip into the folder the still just moved to. A failure
 * is returned rather than thrown: the still's move is already committed and the
 * rest of the batch must go on.
 */
export async function relocateLiveClip(
  clip: LoadedClip,
  libRoot: string,
  newDir: string,
): Promise<ClipMoveResult> {
  try {
    const outcome = await relocateGeoAsset(clip.doc, libRoot, newDir, clip.location);
    return outcome === 'moved'
      ? { ok: true }
      : { ok: false, error: 'Live Photo clip was not moved and stays in its old folder' };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ _id: String(clip.doc._id), err: error }, 'relocateLiveClip: clip move failed');
    return { ok: false, error };
  }
}

/** The client address of a clip that sits next to its still, derived from the still's own address. */
export function clipAddressBesideStill(
  stillAddress: string,
  stillFilename: string,
  clipFilename: string,
): string {
  return stillAddress.endsWith(stillFilename)
    ? `${stillAddress.slice(0, stillAddress.length - stillFilename.length)}${clipFilename}`
    : '';
}
