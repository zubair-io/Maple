import * as path from 'node:path';
import { listDirectoryAssets } from '../db/repos/assets.address.ts';
import type { WithId } from '../db/object-id.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { pairLivePhotos } from './live-photo-pairs.ts';
import { relocateGeoAsset } from './relocate-geo.ts';

const log = childLogger('library/relocate-live-clip');

export interface RelocationMember {
  id: string;
  primary: FileInfo;
}

/** Which of a batch's assets are the clip half of a Live Photo, and where each still's clip lives. */
export interface LiveClipPlan {
  followerClipIds: ReadonlySet<string>;
  clipAbsPathByStillId: ReadonlyMap<string, string>;
}

type PlannedLink =
  | { role: 'clip'; clipId: string }
  | { role: 'still'; stillId: string; clipAbsPath: string };

export type ClipMoveResult = { ok: true } | { ok: false; error: string };

/**
 * Pair each member's folder by Apple content identifier and sort the batch into
 * stills that bring a clip along and clips that only ever follow their still.
 * Only identifier-paired files are linked; a same-stem clip with another or no
 * identifier is an ordinary asset.
 */
export async function planLiveClips(
  members: readonly RelocationMember[],
  libraryRoots: ReadonlyMap<string, string>,
): Promise<LiveClipPlan> {
  const folders = Map.groupBy(
    members,
    (member) => `${member.primary.library_id.toHexString()}\0${member.primary.path}`,
  );
  const planned = await Promise.all(
    [...folders.values()].map(async (folderMembers) => {
      const [{ primary }] = folderMembers as [RelocationMember, ...RelocationMember[]];
      const links = pairLivePhotos(await listDirectoryAssets(primary.library_id, primary.path));
      const libRoot = libraryRoots.get(primary.library_id.toHexString());
      return folderMembers.flatMap((member): readonly PlannedLink[] => {
        const link = links.get(member.primary.filename);
        if (!link) return [];
        if (link.role === 'clip') return [{ role: 'clip', clipId: member.id }];
        return libRoot
          ? [
              {
                role: 'still',
                stillId: member.id,
                clipAbsPath: path.join(libRoot, primary.path, link.partner),
              },
            ]
          : [];
      });
    }),
  );
  const links = planned.flat();
  return {
    followerClipIds: new Set(links.flatMap((link) => (link.role === 'clip' ? [link.clipId] : []))),
    clipAbsPathByStillId: new Map(
      links.flatMap((link) =>
        link.role === 'still' ? [[link.stillId, link.clipAbsPath] as const] : [],
      ),
    ),
  };
}

/**
 * Move a still's paired clip into the folder the still just moved to. A failure
 * is returned rather than thrown: the still's move is already committed and the
 * rest of the batch must go on.
 */
export async function relocateLiveClip(
  clip: WithId<AssetDoc>,
  clipPrimary: FileInfo,
  libRoot: string,
  newDir: string,
): Promise<ClipMoveResult> {
  const assetId = String(clip._id);
  try {
    const outcome = await relocateGeoAsset(clip, libRoot, newDir, clipPrimary);
    return outcome === 'moved'
      ? { ok: true }
      : { ok: false, error: 'Live Photo clip was not moved and stays in its old folder' };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ _id: assetId, err: error }, 'relocateLiveClip: clip move failed');
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
