/**
 * Merge suggestions: reading the banner, and permanently dismissing a pair
 * (#3749).
 *
 * The clustering pass scores every live person against every other and stores
 * each one's ranked candidate list. This module is the read and dismiss side of
 * that: which candidate the banner should show right now, and what happens when
 * an operator says "not the same person".
 *
 * A dismissal is permanent and direction-independent — the key is the two hex
 * ids in ascending order, minted by the one `sortedPairKey` both sides import
 * rather than reimplement. There is no delete path; the row is the record that
 * the operator already answered this question.
 */

import type { ObjectId } from 'mongodb';
import type { SqlStatement } from '../protocol.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import { rankedCandidates, toPerson, type PersonRow } from './people.rows.ts';
import {
  ALL_DISMISSALS_SQL,
  dismissalsForPairsSql,
  INSERT_DISMISSAL_SQL,
  peopleByIdsSql,
  PERSON_BY_ID_SQL,
  SET_SUGGESTION_SQL,
} from './people.sql.ts';
import { sortedPairKey } from '../../../people/people-merge-suggestions.ts';
import type { Bbox, PersonWithId } from '../../schema.ts';

export type DismissMergeSuggestionResult = 'dismissed' | 'stale';

/** Display info for a resolved merge candidate, for the person-page banner. */
export interface SuggestedMergeInfo {
  personId: ObjectId;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  score: number;
}

async function readPerson(db: SqliteDb, hex: string): Promise<PersonWithId | null> {
  const rows = await db.read<PersonRow>(PERSON_BY_ID_SQL, [hex]);
  const row = rows[0];
  return row ? toPerson(row) : null;
}

/** Which of these pair keys have already been dismissed. */
async function dismissedAmong(db: SqliteDb, pairs: readonly string[]): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await db.read<{ pair: string }>(dismissalsForPairsSql(pairs.length), [...pairs]);
  return new Set(rows.map((row) => row.pair));
}

/**
 * Every permanently-dismissed pair, for the clustering pass's suggestion
 * compute. The whole table, deliberately — the pass scores every person against
 * every other, so it needs the whole exclusion set rather than a keyed slice.
 */
export async function loadMergeDismissals(dbOverride?: SqliteDb): Promise<Set<string>> {
  const db = peopleDb(dbOverride);
  const rows = await db.read<{ pair: string }>(ALL_DISMISSALS_SQL);
  return new Set(rows.map((row) => row.pair));
}

/**
 * The person's best still-valid merge candidate, resolved for display.
 *
 * Walks the ranked list rather than reading a single pointer, skipping any
 * candidate since dismissed, merged away, hidden or excluded. That is what lets
 * the banner advance to the next match the moment one is dismissed, instead of
 * going blank until the next clustering pass recomputes.
 *
 * The candidates are fetched in one keyed query rather than one per candidate.
 * The Mongo original issues a `findOne` inside the loop; the list is capped at
 * five, so this is not a hot-path fix, but it is free to write correctly.
 */
export async function loadSuggestedMergeInfo(
  db: SqliteDb,
  person: PersonWithId,
): Promise<SuggestedMergeInfo | null> {
  const candidates = rankedCandidates(person);
  if (candidates.length === 0) return null;

  const personHex = person._id.toHexString();
  const pairKeys = candidates.map((candidate) => sortedPairKey(personHex, candidate.hex));
  const [dismissed, rows] = await Promise.all([
    dismissedAmong(db, pairKeys),
    db.read<PersonRow>(
      peopleByIdsSql(candidates.length),
      candidates.map((candidate) => candidate.hex),
    ),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row] as const));

  for (const candidate of candidates) {
    if (dismissed.has(sortedPairKey(personHex, candidate.hex))) continue;
    const target = byId.get(candidate.hex);
    if (!target || target.merged_into !== null || target.hidden === 1 || target.excluded === 1) {
      continue;
    }
    const resolved = toPerson(target);
    return {
      personId: resolved._id,
      name: resolved.name,
      coverAssetId: resolved.cover_asset_id ?? null,
      coverBbox: resolved.cover_bbox ?? null,
      score: candidate.score,
    };
  }
  return null;
}

/**
 * Recompute one person's denormalised head as the best remaining candidate from
 * their ranked list, skipping dismissed pairs, and clear both head fields when
 * nothing is left.
 *
 * Reads `suggested_merges` only, with no fallback to the head fields. That is
 * deliberate and matches the Mongo original: the head is what this function
 * computes, so treating it as an input would let a dismissed suggestion
 * reinstate itself.
 */
async function advanceHeadStatement(db: SqliteDb, person: PersonWithId): Promise<SqlStatement> {
  const personHex = person._id.toHexString();
  const ranked = (person.suggested_merges ?? []).map((entry) => ({
    hex: entry.person_id.toHexString(),
    score: entry.score,
  }));
  const dismissed = await dismissedAmong(
    db,
    ranked.map((entry) => sortedPairKey(personHex, entry.hex)),
  );
  const next = ranked.find((entry) => !dismissed.has(sortedPairKey(personHex, entry.hex))) ?? null;
  // `suggested_merges` itself is left alone — the ranked list is the clustering
  // pass's output and stays as written until the next pass recomputes it.
  return {
    sql: `UPDATE people SET suggested_merge_person_id = ?, suggested_merge_score = ? WHERE id = ?`,
    params: [next?.hex ?? null, next?.score ?? null, personHex],
  };
}

/**
 * Dismiss the suggestion between two people, permanently.
 *
 * Returns `'stale'` without writing anything when `otherId` is not one of
 * `personId`'s stored candidates — the suggestion already changed server-side,
 * and the route turns that into a 404. Any ranked candidate counts, not just
 * the head: the banner surfaces the best still-valid one, which can sit behind
 * an entry that was already dismissed or has since merged away.
 *
 * The dismissal and both head advances commit together. On Mongo they are three
 * separate writes, so a crash between them can record the dismissal while
 * leaving the banner still showing the pair.
 */
export async function dismissMergeSuggestion(
  personId: ObjectId,
  otherId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<DismissMergeSuggestionResult> {
  const db = peopleDb(dbOverride);
  const personHex = personId.toHexString();
  const otherHex = otherId.toHexString();

  const person = await readPerson(db, personHex);
  if (!person) return 'stale';
  const candidateHexes = [
    ...(person.suggested_merges ?? []).map((entry) => entry.person_id.toHexString()),
    ...(person.suggested_merge_person_id ? [person.suggested_merge_person_id.toHexString()] : []),
  ];
  if (!candidateHexes.includes(otherHex)) return 'stale';

  const other = await readPerson(db, otherHex);
  const pair = sortedPairKey(personHex, otherHex);
  // Compute both advances against a database that already knows about this
  // dismissal, so the pair being dismissed is excluded from the new heads.
  const dismissal: SqlStatement = {
    sql: INSERT_DISMISSAL_SQL,
    params: [pair, new Date().toISOString()],
  };
  await db.write(dismissal.sql, dismissal.params);

  // Advance this side always, and the other side only when it currently points
  // back here — clobbering an unrelated suggestion the other person holds would
  // lose information the operator never asked to discard.
  const advances: SqlStatement[] = [await advanceHeadStatement(db, person)];
  if (other?.suggested_merge_person_id?.toHexString() === personHex) {
    advances.push(await advanceHeadStatement(db, other));
  }
  await db.transaction(advances);
  return 'dismissed';
}

/** Write one person's ranked candidate list and its denormalised head. */
export function suggestionStatement(
  personHex: string,
  headHex: string | null,
  headScore: number | null,
  rankedJson: string | null,
): SqlStatement {
  return { sql: SET_SUGGESTION_SQL, params: [headHex, headScore, rankedJson, personHex] };
}
