// Concrete shared-policy and temporary mask assembly for Background people.
// No publication or host role math lives here; Rust validates both boundaries.
import {
  removal_combine_masks,
  removal_people_suggestions,
  removal_people_mask_suggestions,
  removal_refine_selection,
} from '../raw-pipeline/pkg/raw_wasm';
import type { RemovalPersonSuggestion } from '../generated/removal-models.generated';
import type { RemovalDetection } from './removal-inference.types';
import type { PersonBase } from './removal-person-refinement';
export type RemovalPerson = RemovalPersonSuggestion;

export function suggestPeople(
  detections: RemovalDetection[],
  width: number,
  height: number,
): RemovalPerson[] {
  return JSON.parse(
    removal_people_suggestions(
      JSON.stringify({
        schema: 1,
        source_width: width,
        source_height: height,
        detections,
      }),
    ),
  ) as RemovalPerson[];
}

/** Binary concatenation/lengths only; roles and overlap stay in shared Rust. */
export function suggestPeopleWithMasks(
  people: readonly RemovalPerson[],
  masks: readonly Uint8Array[],
  width: number,
  height: number,
): RemovalPerson[] {
  const input = new Uint8Array(masks.reduce((size, mask) => size + mask.length, 0));
  let offset = 0;
  for (const mask of masks) {
    input.set(mask, offset);
    offset += mask.length;
  }
  return JSON.parse(
    removal_people_mask_suggestions(
      JSON.stringify({
        schema: 1,
        source_width: width,
        source_height: height,
        detections: people.map((person) => person.detection),
        mask_lengths: masks.map((mask) => mask.length),
      }),
      input,
    ),
  ) as RemovalPerson[];
}

export function peopleSelectionMessage(selected: boolean): string {
  return selected
    ? 'Review suggested background people and kept subjects before removing.'
    : 'No background people selected. Review Keep/Remove choices or use Paint.';
}

/** Assemble temporary masks, then subtract the complete protected set from
 * every selected person. Nothing escapes on a failed/cancelled model callback. */
export async function collectPersonMasks(
  people: readonly RemovalPerson[],
  manualProtection: Uint8Array,
  maskForPerson: (detection: RemovalDetection) => Promise<Uint8Array>,
) {
  const detected: Uint8Array[] = [];
  for (const person of people) detected.push(await maskForPerson(person.detection));
  return { ...assemblePersonMasks(people, manualProtection, detected), detected };
}

export function assemblePersonMasks(
  people: readonly RemovalPerson[],
  manualProtection: Uint8Array,
  detected: readonly Uint8Array[],
) {
  if (people.length !== detected.length) throw new Error('Person mask count differs');
  let protectedMask = manualProtection;
  const selected: PersonBase[] = [];
  for (const [index, person] of people.entries()) {
    const mask = detected[index];
    if (person.keep) protectedMask = removal_combine_masks(protectedMask, mask, false);
    else if (mask.length) selected.push({ index, mask });
  }
  const bases = selected
    .map(({ index, mask }) => ({
      index,
      mask: removal_refine_selection(mask, protectedMask, '{"schema":1,"strokes":[]}'),
    }))
    .filter(({ mask }) => mask.length);
  const individual = bases.map(({ mask }) => mask);
  const selection = individual.reduce(
    (union, mask) => removal_combine_masks(union, mask, false),
    new Uint8Array(),
  );
  return { selection, protection: protectedMask, people: individual, bases };
}
