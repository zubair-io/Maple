/**
 * `GET /api/search` on SQLite: one page of the grid, and the total beside it.
 *
 * ## Why the two live in one file
 *
 * A search response carries a page of results and a count of everything that
 * matched, and the failure mode when those disagree is not subtle — the grid
 * shows "1,482 photos" above an empty scroller. The Meilisearch branch produced
 * exactly that once, by post-filtering a single page and reporting a count from
 * a different predicate. Here {@link searchPage} and {@link searchCount} take
 * the same translated {@link SearchWhere} and compose it the same way, so the
 * predicate is not something the two can differ on; the seek predicate and the
 * limit are the only things the page adds, and neither can shrink a count.
 *
 * ## What a page returns
 *
 * `AssetDoc`-shaped rows, not wire results. `projectAsset` in
 * `routes/search/project.ts` is unchanged and keeps doing the projection, so
 * the wire shape cannot drift from the Mongo path during the cutover — and
 * `cursorFromDoc` keeps working on the last row of the page for free.
 *
 * Five statements per page, in two round trips to the pool. The first decides
 * *which* assets; the other four fill in the locations, the caption, the
 * PhotoKit links and the owner for exactly those ids, all at once. That ordering
 * is the semi-join rule again: nothing after the first query can widen or narrow
 * the result set.
 */

import { normaliseObjectIdHex, ObjectId } from '../object-id.ts';
import type { AssetOwnerSummary } from '../assets.transform.ts';
import type { AssetDoc, AssetExif, Place } from '../schema.ts';
import { ownerSummariesForIds } from './assets.owners.ts';
import { groupByAsset, json, toFileInfo, type LocationRow } from './assets.rows.ts';
import { locationsByAssetIdsSql } from './assets.sql.ts';
import {
  countSql,
  descriptionsByAssetIdsSql,
  idPageSql,
  pageColumnsByIdsSql,
  pageSql,
  phassetLinksByAssetIdsSql,
  seekPredicate,
} from './search.sql.ts';
import type { SearchWhere } from './search.where.ts';
import { assetsDb, bulkLane, type SqliteDb } from './db-handle.ts';
import { inGivenOrder } from './search.ranked.ts';

/** The narrow `assets` projection a search result is built from. */
interface PageRow {
  id: string;
  size: number;
  mtime: number;
  indexed_at: string;
  rating: number;
  flag: number;
  color_label: string;
  has_xmp: number;
  hidden: number;
  exif: string | null;
  place: string | null;
  owner_id: string | null;
}

interface DescriptionRow {
  asset_id: string;
  description: string | null;
}

interface LinkRow {
  asset_id: string;
  device_id: string;
  phasset_local_id: string;
  phasset_cloud_id: string | null;
  first_seen: string;
}

/** A search result row as `projectAsset` reads it: the document plus its owner, resolved with it. */
export type SearchDoc = AssetDoc & { _id: ObjectId; owner: AssetOwnerSummary | null };

/** The cursor shape `routes/search/cursor.ts` decodes and validates. */
export interface SeekPosition {
  v: string | null;
  i: string;
  d: 'asc' | 'desc';
}

/** How a page is addressed: a sort, a size, and either a skip or a cursor. */
export interface PageOptions {
  sort: string;
  limit: number;
  /** Rows to skip. Ignored when a cursor is present — a seek replaces it. */
  skip: number;
  cursor?: SeekPosition | null;
}

/**
 * How many assets match — the `total` on the response.
 *
 * Counts the same `FROM` and `WHERE` the page query builds, which is what makes
 * the two agree by construction rather than by review.
 */
export async function searchCount(where: SearchWhere, dbOverride?: SqliteDb): Promise<number> {
  const statement = countSql(where);
  const rows = await assetsDb(dbOverride).read<{ n: number }>(statement.sql, statement.params);
  return rows[0]?.n ?? 0;
}

/**
 * One page of matching assets, newest first unless another sort was asked for.
 *
 * A cursor replaces the skip rather than adding to it: the seek predicate
 * already positions the scan after the previous page's last row, so any offset
 * on top would silently drop that many results.
 *
 * A cursor cannot be combined with a text query, and this refuses the pair
 * rather than serving a page built from it. A ranked page is ordered by
 * `bm25()`, which is not a stored value and not what a cursor records, so
 * resuming a relevance-ordered scan from a capture date lands somewhere
 * arbitrary in it — the page both skips rows the user has not seen and repeats
 * rows they have. `resolvePaging` in `routes/search/list-paging.ts` already
 * answers 400 for the combination and is why no request reaches here with it;
 * that guarantee lives in the layer this one replaces, so it is restated here
 * rather than inherited.
 */
export async function searchPage(
  where: SearchWhere,
  options: PageOptions,
  dbOverride?: SqliteDb,
): Promise<SearchDoc[]> {
  if (options.cursor && where.match.kind === 'match') {
    throw new Error('searchPage: a seek cursor cannot resume a relevance-ordered text query');
  }
  const db = assetsDb(dbOverride);
  const seek = options.cursor ? seekPredicate(options.cursor) : undefined;
  const statement = pageSql(where, options.sort, options.limit, seek ? 0 : options.skip, seek);
  const rows = await db.read<PageRow>(statement.sql, statement.params);
  return hydrate(db, rows);
}

/**
 * The assets behind a stored list of ids, in the stored order, keeping only
 * those that still pass `where`'s live filters. Ids with no surviving row drop
 * out.
 */
export async function searchByIds(
  where: SearchWhere,
  ids: readonly string[],
  dbOverride?: SqliteDb,
): Promise<SearchDoc[]> {
  if (ids.length === 0) return [];
  const db = assetsDb(dbOverride);
  const statement = idPageSql(where, ids);
  const rows = await db.read<PageRow>(statement.sql, statement.params);
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is PageRow => row !== undefined);
  return hydrate(db, ordered);
}

/**
 * Fills a set of chosen `assets` rows out into documents.
 *
 * Four statements, all keyed on the ids the first query already decided on,
 * so nothing here can widen or narrow the result set — the semi-join rule
 * again, one level up. They go out together: the owner lookup used to wait
 * for the other three to come back, one more trip through the reader queue on
 * every search (#4503). They go through the bulk lane, so a page's fan-out can
 * never hold every reader and stall a concurrent grid page (#4413).
 */
async function hydrate(db: SqliteDb, rows: readonly PageRow[]): Promise<SearchDoc[]> {
  if (rows.length === 0) return [];
  const sides = await sideTables(
    bulkLane(db),
    rows.map((row) => row.id),
    rows.map(ownerKey),
  );
  return rows.map((row) => toSearchDoc(row, sides));
}

/**
 * The documents behind a ranked window's page, in the order given (#4514). The window already
 * applied every filter and knows each row's owner, so the page's columns are read beside its side
 * tables — one trip through the bulk lane instead of two.
 */
export async function windowDocs(
  page: readonly { id: string; owner_id: string | null }[],
  dbOverride?: SqliteDb,
): Promise<SearchDoc[]> {
  if (page.length === 0) return [];
  const lane = bulkLane(assetsDb(dbOverride));
  const ids = page.map((row) => row.id);
  const [columns, sides] = await Promise.all([
    lane.read<PageRow>(pageColumnsByIdsSql(ids.length), ids),
    sideTables(lane, ids, page.map(ownerKey)),
  ]);
  const ownerIds = new Map(page.map((row) => [row.id, row.owner_id] as const));
  return inGivenOrder(ids, columns, (row) => row.id).map((row) =>
    toSearchDoc({ ...row, owner_id: ownerIds.get(row.id) ?? null }, sides),
  );
}

interface SideTables {
  locations: ReadonlyMap<string, LocationRow[]>;
  links: ReadonlyMap<string, LinkRow[]>;
  captions: ReadonlyMap<string, string | null>;
  owners: ReadonlyMap<string, AssetOwnerSummary>;
}

async function sideTables(
  lane: SqliteDb,
  ids: readonly string[],
  ownerKeys: readonly (string | null)[],
): Promise<SideTables> {
  const [locations, descriptions, links, owners] = await Promise.all([
    lane.read<LocationRow>(locationsByAssetIdsSql(ids.length), ids),
    lane.read<DescriptionRow>(descriptionsByAssetIdsSql(ids.length), ids),
    lane.read<LinkRow>(phassetLinksByAssetIdsSql(ids.length), ids),
    ownerSummariesForIds(ownerKeys, lane),
  ]);
  return {
    locations: groupByAsset(locations),
    links: groupByAsset(links),
    captions: new Map(descriptions.map((row) => [row.asset_id, row.description] as const)),
    owners,
  };
}

function toSearchDoc(row: PageRow, sides: SideTables): SearchDoc {
  return {
    ...toAssetDoc(row, sides.locations, sides.links, sides.captions),
    owner: sides.owners.get(ownerKey(row) ?? '') ?? null,
  };
}

/**
 * The `users.id` an `owner_id` names: a valid id in the lowercase spelling `users.id` is stored in,
 * anything else as it is, so a corrupt value simply misses (#4511).
 */
function ownerKey(row: { owner_id: string | null }): string | null {
  return normaliseObjectIdHex(row.owner_id) ?? (row.owner_id || null);
}

/** A corrupt `owner_id` stays the raw string rather than failing the whole page (#4511). */
function ownerIdOf(raw: string | null): ObjectId | string | null {
  if (raw === null) return null;
  return ObjectId.isValid(raw) ? new ObjectId(raw) : raw;
}

/**
 * One row plus its side tables, as the document shape `projectAsset` reads.
 *
 * `first_seen` comes back as the ISO string the column stores and becomes a
 * `Date`, which is what the BSON field held and what the type declares. The
 * projection drops it, along with `device_id`, on the way to the wire — but a
 * document that is only half a document is the kind of shortcut that works
 * until some other caller reads the field, so the shape is complete.
 */
function toAssetDoc(
  row: PageRow,
  locations: ReadonlyMap<string, LocationRow[]>,
  links: ReadonlyMap<string, LinkRow[]>,
  captions: ReadonlyMap<string, string | null>,
): AssetDoc & { _id: ObjectId } {
  const linkRows = links.get(row.id) ?? [];
  return {
    _id: new ObjectId(row.id),
    fileinfo: toFileInfo(locations.get(row.id) ?? []),
    size: row.size,
    mtime: row.mtime,
    indexed_at: row.indexed_at,
    rating: row.rating,
    flag: row.flag as -1 | 0 | 1,
    color_label: row.color_label,
    has_xmp: row.has_xmp === 1,
    hidden: row.hidden === 1,
    exif: json<AssetExif>(row.exif),
    place: json<Place>(row.place),
    description: captions.get(row.id) ?? null,
    owner_id: ownerIdOf(row.owner_id),
    phasset_links: linkRows.map((link) => ({
      device_id: link.device_id,
      phasset_local_id: link.phasset_local_id,
      ...(link.phasset_cloud_id === null ? {} : { phasset_cloud_id: link.phasset_cloud_id }),
      first_seen: new Date(link.first_seen),
    })),
  };
}
