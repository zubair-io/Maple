import { indexableNamesForPersonIds } from '../db/repos/people.search-filter.ts';

/** The only face column the name lookup reads. */
export interface FacePerson {
  person_id: string | null;
}

/** The de-duplicated person ids an asset's faces point at, as lowercase hex (the name map's key form). */
function validPersonIds(faces: readonly FacePerson[] | null | undefined): string[] {
  if (!faces || faces.length === 0) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const face of faces) {
    const hex = face.person_id;
    if (!hex || !/^[0-9a-f]{24}$/i.test(hex)) continue;
    const canonical = hex.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    ids.push(canonical);
  }
  return ids;
}

/**
 * Indexable person names for one or more assets, in a single query.
 *
 * "Indexable" is stricter than the facet picker's visibility: merged, hidden and excluded people
 * (#2894 — an excluded person's name must not be searchable) are out, and so are auto-generated
 * `Person N` cluster names, which are placeholders that would pollute the index with the token
 * "person".
 */
export async function loadNamedPeople(
  faceSets: ReadonlyArray<readonly FacePerson[] | null | undefined>,
): Promise<Map<string, string>> {
  const uniqueIds = new Set<string>();
  for (const faces of faceSets) {
    for (const id of validPersonIds(faces)) uniqueIds.add(id);
  }
  if (uniqueIds.size === 0) return new Map();
  return indexableNamesForPersonIds([...uniqueIds]);
}

/** Resolve an asset's ordered, de-duplicated names from a batch name map. */
export function peopleNamesForFaces(
  faces: readonly FacePerson[] | null | undefined,
  namesById: ReadonlyMap<string, string>,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const id of validPersonIds(faces)) {
    const name = namesById.get(id);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
