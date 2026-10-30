import { liveFileKind, liveStem, type LiveFileKind } from '../indexer/live-photo/live-file-kind.ts';

/** One half of a paired Live Photo: which half it is, and the other file's name in the same folder. */
export interface LivePhotoLink {
  role: LiveFileKind;
  partner: string;
}

export interface LivePhotoCandidate {
  filename: string;
  live_content_id: string | null;
}

/**
 * The Live Photo pairs among one folder's assets. A still and a clip pair only
 * when they share a stem AND carry the same Apple content identifier; the stem
 * only nominates candidates, because `IMG_1234` repeats across cameras and
 * imports. A stem-and-identifier group that does not hold exactly one still and
 * one clip is ambiguous, and leaves every member independent.
 */
export function pairLivePhotos(
  assets: readonly LivePhotoCandidate[],
): ReadonlyMap<string, LivePhotoLink> {
  const groups = Map.groupBy(
    assets.flatMap((asset) => {
      const kind = liveFileKind(asset.filename);
      return kind && asset.live_content_id
        ? [
            {
              filename: asset.filename,
              kind,
              key: `${liveStem(asset.filename)}\0${asset.live_content_id}`,
            },
          ]
        : [];
    }),
    (member) => member.key,
  );
  return new Map(
    [...groups.values()].flatMap((members) => {
      const stills = members.filter((member) => member.kind === 'still');
      const clips = members.filter((member) => member.kind === 'clip');
      const [still, clip] = [stills[0], clips[0]];
      return stills.length === 1 && clips.length === 1 && still && clip
        ? [
            [still.filename, { role: 'still', partner: clip.filename }],
            [clip.filename, { role: 'clip', partner: still.filename }],
          ]
        : [];
    }) as [string, LivePhotoLink][],
  );
}
