/**
 * Library-level collections: registered roots, face-cluster identities, the
 * key/value singletons, the operator settings, the mirror copy queue, the
 * geocode cache, presets — and the change log, which is the one collection
 * where a full import would be the wrong answer.
 *
 * ## Why the change log is windowed
 *
 * `asset_changes` is around 176 million rows on production, roughly 525 per
 * asset, and every one of them exists to answer a single question: "what
 * changed since cursor N?" for a File Provider client that has been away. The
 * rows are not the library. They are a replication journal over it, and the
 * library itself is the authority every client can fall back to by
 * re-enumerating — which clients already do, and already handle, because the
 * cursor allocation is explicitly documented as non-contiguous and the SSE path
 * answers a too-old cursor with a 409 that triggers exactly that.
 *
 * So the importer carries the newest {@link DEFAULT_CHANGES_WINDOW} rows and
 * lets anything older re-enumerate. A client that has synced recently keeps its
 * incremental path; one that has been offline long enough to fall off the
 * window pays one enumeration, once. The alternative — importing all 176
 * million — would dominate both the operator's downtime, which is the cost the
 * ticket asks us to measure, and the resulting database file, to buy back a
 * fast path for clients that are already on the slow one.
 *
 * Two things make the window safe rather than merely cheap. The cursor counter
 * in `server_state` is imported verbatim, so newly allocated cursors continue
 * above the imported rows and no cursor is ever reused. And the floor is
 * persisted on first use, so a resumed run imports the same set even if the
 * source moved on in between.
 *
 * One residual gap is worth naming rather than burying: `GET /api/changes` has
 * no too-old-cursor check today — it answers `cursor > since` and returns
 * whatever it finds — so a client below the floor would be told it is up to
 * date instead of being sent to re-enumerate. That check belongs with the
 * repository port that rewrites the route, and #3741's retention sweep shrinks
 * this collection on the Mongo side independently.
 *
 * `--changes-window all` imports the lot for an operator who would rather pay
 * the time.
 */

import type { Db, Document, Filter } from 'mongodb';
import type { CollectionPlan, ImportOptions } from '../types.ts';
import {
  asArray,
  idToHex,
  intOr,
  toBit,
  toEnum,
  toEpochMs,
  toIso,
  toJsonText,
  toNumber,
  toText,
  textOr,
} from '../values.ts';
import { docId, docKey, onePerDocument } from './shared.ts';
import { caseFoldKey } from '../../case-fold.ts';

/** Newest change rows carried over by default. */
export const DEFAULT_CHANGES_WINDOW = 100_000;

/** `import_meta` key holding the floor a windowed change import settled on. */
export const CHANGES_FLOOR_KEY = 'asset_changes.cursor_floor';

const foldersPlan = onePerDocument({
  source: 'folders',
  table: 'folders',
  columns: ['id', 'path', 'slug', 'label', 'last_scan', 'file_count', 'created_at', 'mirrors'],
  values: (doc) => {
    const id = docId(doc);
    return [
      id,
      textOr(doc.path, ''),
      textOr(doc.slug, id),
      textOr(doc.label, ''),
      toIso(doc.last_scan),
      intOr(doc.file_count, 0),
      toIso(doc.created_at) ?? new Date(0).toISOString(),
      asArray(doc.mirrors).length > 0 ? toJsonText(doc.mirrors) : null,
    ];
  },
});

const peoplePlan = onePerDocument({
  source: 'people',
  table: 'people',
  columns: [
    'id',
    'name',
    'name_key',
    'created_at',
    'updated_at',
    'cover_asset_id',
    'cover_bbox_x',
    'cover_bbox_y',
    'cover_bbox_w',
    'cover_bbox_h',
    'merged_into',
    'hidden',
    'excluded',
    'centroid',
    'centroid_face_count',
    'suggested_merge_person_id',
    'suggested_merge_score',
    'suggested_merges',
  ],
  values: (doc) => {
    const bbox = (doc.cover_bbox ?? {}) as Record<string, unknown>;
    const now = new Date(0).toISOString();
    return [
      docId(doc),
      textOr(doc.name, ''),
      // The schema derives the face count rather than storing it, but the
      // folded name key is stored and NOT NULL — it is what uniqueness and
      // every rename-merge lookup compare, so the import mints it here rather
      // than leaving the first rename to discover it is missing.
      caseFoldKey(textOr(doc.name, '')),
      toIso(doc.created_at) ?? now,
      toIso(doc.updated_at) ?? now,
      idToHex(doc.cover_asset_id),
      toNumber(bbox.x),
      toNumber(bbox.y),
      toNumber(bbox.w),
      toNumber(bbox.h),
      idToHex(doc.merged_into),
      toBit(doc.hidden),
      toBit(doc.excluded),
      toJsonText(doc.centroid),
      toNumber(doc.centroid_face_count),
      idToHex(doc.suggested_merge_person_id),
      toNumber(doc.suggested_merge_score),
      toJsonText(doc.suggested_merges),
    ];
  },
});

const dismissalsPlan = onePerDocument({
  source: 'person_merge_dismissals',
  table: 'person_merge_dismissals',
  columns: ['pair', 'created_at'],
  values: (doc) => {
    const pair = toText(doc.pair);
    if (pair === null) throw new Error('pair is empty');
    return [pair, toIso(doc.created_at) ?? new Date(0).toISOString()];
  },
});

const presetsPlan = onePerDocument({
  source: 'presets',
  table: 'presets',
  columns: ['id', 'name', 'schema_version', 'fields', 'extra', 'created_at', 'updated_at'],
  values: (doc) => {
    const now = new Date(0).toISOString();
    return [
      docId(doc),
      textOr(doc.name, ''),
      intOr(doc.schema_version, 1),
      toJsonText(doc.fields) ?? '{}',
      toJsonText(doc.extra),
      toIso(doc.created_at) ?? now,
      toIso(doc.updated_at) ?? now,
    ];
  },
});

const geocodeCachePlan = onePerDocument({
  source: 'geocode_cache',
  table: 'geocode_cache',
  idKind: 'string',
  columns: ['id', 'place', 'fetched_at', 'geocoder_version'],
  values: (doc) => {
    const place = toJsonText(doc.place);
    if (place === null) throw new Error('place is missing');
    return [
      docKey(doc),
      place,
      toIso(doc.fetched_at) ?? new Date(0).toISOString(),
      intOr(doc.geocoder_version, 0),
    ];
  },
});

const serverStatePlan = onePerDocument({
  source: 'server_state',
  table: 'server_state',
  idKind: 'string',
  columns: ['id', 'seq', 'value'],
  values: (doc) => [docKey(doc), toNumber(doc.seq), toText(doc.value)],
});

/**
 * Operator settings — Cloudflare credentials, the map and pano configuration,
 * network and observability, the worker tunables. One document per key, stored
 * whole so a setting this server version does not know about survives the
 * cutover instead of being silently dropped.
 */
const appSettingsPlan = onePerDocument({
  source: 'app_settings',
  table: 'app_settings',
  idKind: 'string',
  columns: ['id', 'doc'],
  values: (doc) => {
    const { _id, ...rest } = doc;
    void _id;
    return [docKey(doc), toJsonText(rest) ?? '{}'];
  },
});

const mirrorQueuePlan = onePerDocument({
  source: 'mirror_queue',
  table: 'mirror_queue',
  columns: [
    'primary_path',
    'mirror_path',
    'reason',
    'claimed_at',
    'attempts',
    'last_error',
    'dead',
    'enqueued_at',
  ],
  values: (doc) => {
    const reason = toEnum(doc.reason, ['scan-missing', 'write-failure'] as const);
    if (reason === null) throw new Error(`unknown mirror_queue reason ${String(doc.reason)}`);
    return [
      textOr(doc.primary_path, ''),
      textOr(doc.mirror_path, ''),
      reason,
      toEpochMs(doc.claimed_at),
      intOr(doc.attempts, 0),
      toText(doc.last_error),
      toBit(doc.dead),
      toEpochMs(doc.enqueued_at) ?? 0,
    ];
  },
});

const CHANGE_KINDS = ['create', 'update', 'delete', 'restore'] as const;

const assetChangesPlan: CollectionPlan = {
  source: 'asset_changes',
  tables: ['asset_changes'],
  idKind: 'objectid',
  async bound(db: Db, options: ImportOptions): Promise<Filter<Document> | null> {
    if (options.changesWindow === 'all') return null;
    const newest = await db
      .collection('asset_changes')
      .find({}, { projection: { cursor: 1 }, sort: { cursor: -1 }, limit: options.changesWindow })
      .toArray();
    const floor = newest.at(-1)?.cursor;
    return typeof floor === 'number' ? { cursor: { $gte: floor } } : null;
  },
  map(doc) {
    const kind = toEnum(doc.kind, CHANGE_KINDS);
    if (kind === null) throw new Error(`unknown change kind ${String(doc.kind)}`);
    const cursor = toNumber(doc.cursor);
    if (cursor === null) throw new Error('cursor is missing');
    return [
      {
        table: 'asset_changes',
        columns: ['cursor', 'asset_id', 'folder_id', 'kind', 'abs_path', 'relative_path', 'at'],
        rows: [
          [
            cursor,
            idToHex(doc.asset_id),
            idToHex(doc.folder_id),
            kind,
            toText(doc.abs_path),
            typeof doc.relative_path === 'string' ? doc.relative_path : null,
            toIso(doc.at) ?? new Date(0).toISOString(),
          ],
        ],
      },
    ];
  },
  async expected(db, filter) {
    return { asset_changes: await db.collection('asset_changes').countDocuments(filter) };
  },
};

/** Library-level plans, in foreign-key order. */
export const LIBRARY_PLANS: CollectionPlan[] = [
  foldersPlan,
  peoplePlan,
  dismissalsPlan,
  presetsPlan,
  geocodeCachePlan,
  serverStatePlan,
  appSettingsPlan,
  mirrorQueuePlan,
  assetChangesPlan,
];
