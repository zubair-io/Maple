import { removal_combine_masks } from '../raw-pipeline/pkg/raw_wasm';
import type { RemovalAuthoringClient } from '../raw-pipeline/raw-pipeline.removal-client';
import type { RemovalStroke } from './removal-editor-session.service';

export interface PersonBase {
  index: number;
  mask: Uint8Array;
}
export interface PersonGesture {
  index: number;
  strokes: RemovalStroke[];
}

/** Replay only manual corrections, without inference, retaining one native
 * generation mask per person. Rust work executes in the retained RAW worker. */
export async function refinePeople(
  bases: readonly PersonBase[],
  gestures: readonly PersonGesture[],
  protection: Uint8Array,
  client: RemovalAuthoringClient,
) {
  const masks: Uint8Array[] = [];
  for (const base of bases) {
    const strokes = gestures
      .filter((gesture) => gesture.index === base.index)
      .flatMap((gesture) => gesture.strokes);
    const mask = await client.refineSelection(
      base.mask,
      JSON.stringify({ schema: 1, strokes }),
      protection,
    );
    if (mask.length) masks.push(mask);
  }
  const selection = masks.reduce(
    (union, mask) => removal_combine_masks(union, mask, false),
    new Uint8Array(),
  );
  return { selection, masks };
}
