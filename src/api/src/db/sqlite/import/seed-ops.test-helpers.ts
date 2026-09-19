/**
 * The seeded operational, auth and change-log documents, plus the four
 * collections the importer deliberately leaves behind.
 *
 * The point of seeding the last group is that "not imported" is a decision the
 * tests should hold the importer to, not an omission: if a later change quietly
 * starts carrying `migrations` or `image_access_tokens` across, a test fails.
 */

import { Binary, ObjectId, type Db } from 'mongodb';
import { PLACE, iso, type SeedIds } from './seed-fixtures.test-helpers.ts';

/** Queues, configuration and the key/value singletons. */
export async function seedOperational(db: Db, ids: SeedIds): Promise<void> {
  await db.collection('geocode_cache').insertOne({
    _id: 'lat:42.6526,lon:-73.7562',
    place: PLACE,
    fetched_at: new Date(Date.UTC(2026, 0, 2)),
    geocoder_version: 3,
  } as never);

  await db.collection('server_state').insertMany([
    { _id: 'asset_changes_cursor', seq: 4242 },
    { _id: 'jwt_secret', value: 'a-very-secret-value' },
  ] as never);

  await db.collection('app_settings').insertMany([
    {
      _id: 'cloudflare',
      config: {
        enabled: true,
        account_id: 'acct',
        bucket: 'thumbs',
        access_key_id: 'key',
        secret_access_key: 'secret',
      },
    },
    { _id: 'map', config: { provider: 'osm', tile_url: 'https://tiles.example/{z}/{x}/{y}.png' } },
  ] as never);

  await db.collection('mirror_queue').insertOne({
    primary_path: '/libraries/a/IMG_0001.dng',
    mirror_path: '/mirrors/a/IMG_0001.dng',
    reason: 'scan-missing',
    claimed_at: null,
    attempts: 1,
    last_error: null,
    dead: false,
    enqueued_at: 1_767_225_600_000,
  } as never);

  await db.collection('presets').insertOne({
    name: 'Punchy',
    schema_version: 1,
    fields: { exposure: 0.25, contrast: 12 },
    extra: { unknown_future_key: true },
    created_at: iso(0),
    updated_at: iso(1),
  } as never);

  await db.collection('jobs').insertOne({
    kind: 'batch_jpeg_export',
    status: 'done',
    payload: { asset_ids: [ids.assets.rich.toHexString()] },
    progress: { current: 1, total: 1 },
    result: { written: 1 },
    error: null,
    locked_by: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: iso(1),
    updated_at: iso(1),
    batch_scopes: [ids.libraryA.toHexString()],
  } as never);

  await db.collection('imports').insertOne({
    _id: ids.importJob,
    status: 'done',
    source_root: '/incoming',
    library_id: ids.libraryA,
    library_root: '/libraries/a',
    scan_pending: false,
    progress: { current: 2, total: 2 },
    counts: { copied: 2, skipped: 0, failed: 0 },
    error: null,
    locked_by: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: iso(1),
    updated_at: iso(1),
  } as never);

  // Older than the `import_files` collection: its files are still inline, the
  // shape `ImportDoc.files` documents as read best-effort and never written.
  await db.collection('imports').insertOne({
    _id: ids.legacyImportJob,
    status: 'done',
    source_root: '/incoming/old',
    library_id: ids.libraryA,
    library_root: '/libraries/a',
    scan_pending: false,
    progress: { current: 2, total: 2 },
    counts: { copied: 1, skipped: 1, failed: 0 },
    error: null,
    locked_by: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: iso(0),
    updated_at: iso(0),
    files: [
      {
        src: '/incoming/old/b.dng',
        dest: '2025/12/b.dng',
        size: 20,
        mtime: 2,
        kind: 'image',
        state: 'copied',
        error: null,
      },
      {
        src: '/incoming/old/b.mov',
        dest: '2025/12/b.mov',
        size: 30,
        mtime: 2,
        kind: 'movie',
        state: 'skipped_duplicate',
        error: null,
      },
    ],
  } as never);

  // Written during the changeover, so it carries BOTH copies of its file list
  // (#3791). Production has exactly one of these. The two copies agree there;
  // here they deliberately do not, so a test can tell which one was written —
  // the rows are the canonical copy and the inline entries must not appear.
  await db.collection('imports').insertOne({
    _id: ids.mixedImportJob,
    status: 'done',
    source_root: '/incoming/mixed',
    library_id: ids.libraryA,
    library_root: '/libraries/a',
    scan_pending: false,
    progress: { current: 1, total: 1 },
    counts: { copied: 1, skipped: 0, failed: 0 },
    error: null,
    locked_by: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: iso(0),
    updated_at: iso(1),
    files: [
      {
        src: '/incoming/mixed/stale-inline.dng',
        dest: '2025/11/stale-inline.dng',
        size: 40,
        mtime: 3,
        kind: 'image',
        state: 'copied',
        error: null,
      },
    ],
  } as never);

  await db.collection('import_files').insertMany([
    {
      import_id: ids.importJob,
      idx: 0,
      src: '/incoming/a.dng',
      dest: '2026/01/a.dng',
      size: 10,
      mtime: 1,
      kind: 'image',
      state: 'copied',
      error: null,
    },
    {
      import_id: ids.importJob,
      idx: 1,
      src: '/incoming/a.xmp',
      dest: '2026/01/a.xmp',
      size: 2,
      mtime: 1,
      kind: 'sidecar',
      state: 'copied',
      error: null,
    },
    // The canonical copy of the mixed import's one file. Same ordinal as its
    // inline entry, a different `src`, so only one of the two can land.
    {
      import_id: ids.mixedImportJob,
      idx: 0,
      src: '/incoming/mixed/promoted-row.dng',
      dest: '2025/11/promoted-row.dng',
      size: 40,
      mtime: 3,
      kind: 'image',
      state: 'copied',
      error: null,
    },
  ] as never);

  await db.collection('indexer_queue').insertOne({
    kind: 'scan_folder',
    payload: { folder_id: ids.libraryA.toHexString() },
    status: 'done',
    error: null,
    created_at: iso(1),
    updated_at: iso(1),
  } as never);

  await db.collection('discover_frontier').insertOne({
    folder_id: ids.libraryA,
    dir_path: '/libraries/a/vacation',
    sweep_gen: 7,
    claimed_at: null,
    enqueued_at: 1_767_225_600_000,
    hidden_ancestor: true,
  } as never);

  await db.collection('worker_config').insertMany([
    {
      name: 'describe',
      concurrency: 2,
      maxAttempts: 1,
      paused: true,
      pause_reason: 'no model',
      last_seen_target_version: 8,
    },
    {
      name: 'thumb',
      concurrency: 8,
      maxAttempts: 3,
      paused: false,
      last_seen_target_version: 2,
    },
    // The discover sweeper shares this collection and fills in different
    // fields: no stage knobs, and the one interval only it has.
    { name: 'discover', paused: false, sweepDirIntervalMs: 900 },
  ] as never);

  await db.collection('stage_handlers').insertOne({
    stage: 'ai',
    impl: 'http',
    url: 'https://ai.example',
    timeout_ms: 5000,
    enabled: true,
  } as never);

  await db.collection('backup_sessions').insertOne({
    library_id: ids.libraryA,
    device_id: 'device-a',
    started_at: new Date(Date.UTC(2026, 0, 2)),
    last_progress_at: new Date(Date.UTC(2026, 0, 3)),
    total_count: 10,
    uploaded_count: 9,
    failed_count: 1,
  } as never);

  await db.collection('upload_sessions').insertOne({
    library_id: ids.libraryA,
    device_id: 'device-a',
    phasset_local_id: 'LOCAL-3/L0/001',
    phasset_cloud_id: 'CLOUD-3',
    target_rel_path: '2026/01/IMG_0007.heic',
    total_bytes: 1000,
    received_bytes: 500,
    chunk_size: 250,
    state: 'open',
    created_at: new Date(Date.UTC(2026, 0, 5)),
    updated_at: new Date(Date.UTC(2026, 0, 5, 1)),
  } as never);

  await db.collection('apns_device_tokens').insertOne({
    user_id: ids.owner,
    device_token: 'ff'.repeat(32),
    platform: 'ios',
    environment: 'production',
    created_at: new Date(Date.UTC(2026, 0, 2)),
    updated_at: new Date(Date.UTC(2026, 0, 2)),
  } as never);
}

/** Users, passkeys and the token tables. */
export async function seedAuth(db: Db, ids: SeedIds): Promise<void> {
  await db.collection('users').insertOne({
    _id: ids.owner,
    email: 'Owner@Example.com',
    role: 'owner',
    created_at: iso(0),
    last_seen_at: iso(9),
  } as never);

  await db.collection('credentials').insertOne({
    user_id: ids.owner,
    credential_id: 'Y3JlZC0x',
    public_key: new Binary(Uint8Array.from([1, 2, 3, 4, 250])),
    counter: 7,
    transports: ['internal', 'hybrid'],
    device_label: 'A Mac',
    created_at: iso(0),
    last_used_at: iso(9),
  } as never);

  await db.collection('invites').insertOne({
    code: 'ABCD2345',
    email: 'guest@example.com',
    invited_by: ids.owner,
    expires_at: new Date(Date.UTC(2026, 1, 1)),
    consumed_at: null,
  } as never);

  await db.collection('refresh_tokens').insertOne({
    user_id: ids.owner,
    token_hash: 'b'.repeat(64),
    issued_at: iso(9),
    expires_at: new Date(Date.UTC(2026, 2, 1)),
    revoked_at: null,
    replaced_by: null,
    device_label: 'Safari',
    family_id: new ObjectId(),
    platform: 'tvos',
    secure: false,
  } as never);

  await db.collection('service_api_keys').insertOne({
    key_id: 'svc_abc',
    name: 'search bot',
    secret_hash: 'c'.repeat(64),
    scopes: ['assets:search'],
    created_at: iso(0),
    created_by: ids.owner,
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
  } as never);

  await db.collection('challenges').insertOne({
    challenge: 'Y2hhbGxlbmdl',
    purpose: 'authenticate',
    user_id: ids.owner,
    email: null,
    invite_code: null,
    expires_at: new Date(Date.UTC(2026, 0, 1, 0, 5)),
  } as never);

  await db.collection('native_auth_codes').insertOne({
    code_hash: 'd'.repeat(64),
    code_challenge: 'Y2hhbGxlbmdl',
    state: 'state-1',
    user_id: ids.owner,
    device_label: 'Maple for macOS',
    created_at: iso(9),
    expires_at: new Date(Date.UTC(2026, 0, 1, 0, 5)),
    consumed_at: null,
  } as never);

  await db.collection('lan_handoff_codes').insertOne({
    code_hash: 'e'.repeat(64),
    user_id: ids.owner,
    device_label: 'LAN',
    created_at: iso(9),
    expires_at: new Date(Date.UTC(2026, 0, 1, 0, 5)),
    consumed_at: null,
  } as never);
}

/** `count` change rows with cursors 1..count. */
export async function seedChanges(db: Db, ids: SeedIds, count: number): Promise<number[]> {
  const cursors = Array.from({ length: count }, (_, index) => index + 1);
  await db.collection('asset_changes').insertMany(
    cursors.map((cursor) => ({
      cursor,
      asset_id: cursor % 3 === 0 ? null : ids.assets.rich,
      folder_id: ids.libraryA,
      kind: (['create', 'update', 'delete', 'restore'] as const)[cursor % 4],
      abs_path: `/libraries/a/IMG_${String(cursor).padStart(4, '0')}.dng`,
      relative_path: `IMG_${String(cursor).padStart(4, '0')}.dng`,
      at: new Date(Date.UTC(2026, 0, 1) + cursor * 1000),
    })) as never,
  );
  return cursors;
}

/** Collections the importer deliberately leaves behind. */
export async function seedNotImported(db: Db, ids: SeedIds): Promise<void> {
  await db
    .collection('migrations')
    .insertOne({ _id: 'backfill-media-kind-2026-09-11', applied_at: new Date(), rows: 3 } as never);
  await db
    .collection('worker_status')
    .insertOne({ _id: 'singleton', statuses: {}, updated_at: Date.now() } as never);
  await db.collection('image_access_tokens').insertOne({
    _id: 'f'.repeat(64),
    path: '/api/thumb/abc',
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    purpose: 'image-read',
  } as never);
  await db.collection('generated_searches').insertOne({
    library_id: ids.libraryA.toHexString(),
    generated_for: '2026-01-01',
    generated_at: iso(1),
    model: 'qwen',
    attempts: 1,
    theme: 'winter',
    title: 'Winter walks',
    subtitle: null,
    query: {},
    result_count: 3,
    cover_asset_id: null,
  } as never);
  // The two the retired bounded-channel indexer left behind on every install
  // that ever ran it. Seeded with rows rather than empty, because production's
  // dead-letter queue happens to be empty and the skip must not rest on that.
  await db.collection('indexer_config').insertOne({
    _id: 'workers',
    updatedAt: Date.now(),
    workers: { discover: 32, hash: 32, exif: 32, thumb: 32, ai: 27, mongo: 32 },
  } as never);
  await db.collection('indexer_dead_letter').insertOne({
    key: '/libraries/a/IMG_0001.dng',
    stage: 'hash',
    absPath: '/libraries/a/IMG_0001.dng',
    error: 'EIO',
    attempts: 3,
    firstFailedAt: iso(2),
    lastFailedAt: iso(3),
  } as never);
}
