import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlitePool, closeSqlitePool } from '../db/sqlite/index.ts';
import { saveCloudflareConfig } from './cloudflare-config.repo.ts';
import {
  DEFAULT_DB_BACKUP_POLICY,
  loadDbBackupSettings,
  saveDbBackupPolicy,
  saveDbBackupStatus,
} from './backup-retain-config.ts';
import { backupDue, backupRunning, runDbBackupPass } from './db-backup.ts';
import { createSnapshot } from './backup-snapshot.ts';
import { BackupR2 } from './backup-r2.ts';
import { restoreBackup } from './backup-restore.ts';
import { computeBackupKey } from './backup-key.ts';
import { expiredBackups } from './backup-retention.ts';

const config = {
  account_id: 'test',
  bucket: 'backup-test',
  access_key_id: 'test-key',
  secret_access_key: 'test-secret',
};
const fetchOriginal = globalThis.fetch;
let directory: string;
let source: string;
const objects = new Map<string, { bytes: ArrayBuffer; headers: Headers }>();
let uploadFails = false;
let corruptDownload = false;
let deletes = 0;
let uploadGate: Promise<void> = Promise.resolve();

const signal = () => new AbortController().signal;
const forcedBackup = () =>
  runDbBackupPass(signal(), { force: true }).catch((error: unknown) => error);
const scheduledBackup = () => runDbBackupPass(signal()).catch((error: unknown) => error);
const backups = async () => (await new BackupR2(config).list()).length;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'maple-backup-test-'));
  source = join(directory, 'source.db');
  const db = new Database(source);
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)');
  db.run("INSERT INTO schema_migrations VALUES ('0001-test')");
  db.run('CREATE TABLE app_settings (id TEXT PRIMARY KEY, doc TEXT NOT NULL)');
  db.run('CREATE TABLE photos (id INTEGER PRIMARY KEY, name TEXT)');
  db.run("INSERT INTO photos VALUES (1, 'original')");
  db.close();
  await openSqlitePool({ path: source, readers: 1 });
  await saveCloudflareConfig(config);
  await saveDbBackupPolicy({ ...DEFAULT_DB_BACKUP_POLICY, bucket: config.bucket });
  objects.clear();
  uploadFails = false;
  corruptDownload = false;
  deletes = 0;
  uploadGate = Promise.resolve();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (request.method === 'PUT') {
      await uploadGate;
      if (uploadFails) return new Response('unavailable', { status: 503 });
      objects.set(key, { bytes: await request.arrayBuffer(), headers: request.headers });
      return new Response(null);
    }
    if (url.searchParams.has('list-type'))
      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects.keys()].map((objectKey) => `<Contents><Key>${objectKey}</Key></Contents>`).join('')}</ListBucketResult>`,
      );
    if (url.searchParams.has('delete')) {
      deletes++;
      return new Response('<DeleteResult/>');
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers(object.headers);
    if (corruptDownload) headers.set('x-amz-meta-sha256', '0'.repeat(64));
    return new Response(object.bytes, { headers });
  }) as typeof fetch;
});

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(5);
  }
  throw new Error('timed out');
}

afterEach(async () => {
  globalThis.fetch = fetchOriginal;
  closeSqlitePool();
  await rm(directory, { recursive: true, force: true });
});

test('online WAL snapshot restores committed data without altering source', async () => {
  const writer = new Database(source);
  writer.run("INSERT INTO photos VALUES (2, 'in WAL')");
  const snapshot = join(directory, 'snapshot.db');
  const info = await createSnapshot(source, snapshot);
  expect(info.schema).toBe('0001-test');
  const storage = new BackupR2(config);
  const key = computeBackupKey(info.schema);
  await storage.upload(key, `${snapshot}.gz`, info, 'test');
  const target = join(directory, 'restored.db');
  await restoreBackup(await storage.download(key), target);
  const restored = new Database(target, { readonly: true });
  expect(restored.query('SELECT name FROM photos ORDER BY id').all()).toEqual([
    { name: 'original' },
    { name: 'in WAL' },
  ]);
  restored.close();
  expect(writer.query('SELECT count(*) AS count FROM photos').get()).toEqual({ count: 2 });
  writer.close();
  expect((await readdir(directory)).some((name) => name.startsWith('.maple-restore-'))).toBe(false);
});

test('a failed backup is recorded without pruning, and a later one succeeds', async () => {
  uploadFails = true;
  expect(await forcedBackup()).toBeInstanceOf(Error);
  expect((await loadDbBackupSettings()).status?.state).toBe('failed');
  expect(deletes).toBe(0);
  uploadFails = false;
  expect(await forcedBackup()).toBeUndefined();
  const settings = await loadDbBackupSettings();
  expect(settings.status?.state).toBe('succeeded');
  expect(settings.last_success_at).toBeTruthy();
  expect(settings.status?.bytes).toBeGreaterThan(0);
  expect(await new BackupR2(config).list()).toEqual([settings.status!.key!]);
});

test('a backup that cannot create its scratch directory is recorded as failed', async () => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = join(directory, 'missing');
  try {
    expect(await forcedBackup()).toBeInstanceOf(Error);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
  expect((await loadDbBackupSettings()).status?.state).toBe('failed');
  expect(await forcedBackup()).toBeUndefined();
});

test('a backup in progress is stored as running with a heartbeat', async () => {
  const upload = Promise.withResolvers<void>();
  uploadGate = upload.promise;
  const backup = forcedBackup();
  const running = await until(async () => (await loadDbBackupSettings()).status);
  expect(running.state).toBe('running');
  expect(running.heartbeat_at).toBeTruthy();
  expect(backupRunning(running)).toBe(true);

  upload.resolve();
  await backup;

  expect((await loadDbBackupSettings()).status?.state).toBe('succeeded');
});

test('corrupt download prevents pruning and restore publication', async () => {
  corruptDownload = true;
  await forcedBackup();
  expect((await loadDbBackupSettings()).status?.state).toBe('failed');
  expect(deletes).toBe(0);
  expect(await new BackupR2(config).list()).toEqual([]);
  const key = [...objects.keys()][0]!;
  const target = join(directory, 'restored.db');
  await expect(restoreBackup(await new BackupR2(config).download(key), target)).rejects.toThrow(
    'checksum',
  );
  expect(await Bun.file(target).exists()).toBe(false);
});

test('malformed compressed backup fails restore without hanging', async () => {
  const target = join(directory, 'malformed.db');
  const response = new Response(new Uint8Array([0, 1, 2, 3]), {
    headers: {
      'x-amz-meta-sha256': '0'.repeat(64),
      'x-amz-meta-uncompressed-size': '1',
      'x-amz-meta-schema-version': '0001-test',
    },
  });
  await expect(restoreBackup(response, target)).rejects.toThrow();
  expect(await Bun.file(target).exists()).toBe(false);
});

test('restore refuses existing database and orphan WAL', async () => {
  await Bun.write(join(directory, 'target.db-wal'), 'preserve');
  await expect(restoreBackup(new Response('unused'), join(directory, 'target.db'))).rejects.toThrow(
    'already exists',
  );
  expect(await Bun.file(join(directory, 'target.db-wal')).text()).toBe('preserve');
  await expect(restoreBackup(new Response('unused'), source)).rejects.toThrow('already exists');
});

test('GFS retains newest per UTC period, latest always, and ignores foreign and future keys', () => {
  const key = (date: string) => computeBackupKey('0001-test', new Date(date));
  const newest = key('2026-09-20T15:00:00Z');
  const duplicate = key('2026-09-20T03:00:00Z');
  const weekly = key('2026-08-31T03:00:00Z');
  const monthly = key('2026-02-01T03:00:00Z');
  const yearly = key('2022-01-01T03:00:00Z');
  const expired = key('2021-12-31T03:00:00Z');
  const future = key('2027-01-01T03:00:00Z');
  const keys = [
    newest,
    duplicate,
    weekly,
    monthly,
    yearly,
    expired,
    future,
    'thumbs/a',
    'backups/sqlite/unknown',
  ];
  expect(
    expiredBackups(keys, DEFAULT_DB_BACKUP_POLICY, Date.parse('2026-09-20T16:00:00Z')),
  ).toEqual([duplicate, expired]);
  expect(
    expiredBackups(
      [newest, duplicate],
      { ...DEFAULT_DB_BACKUP_POLICY, daily: 0, weekly: 0, monthly: 0, yearly: 0 },
      Date.parse('2026-09-20T16:00:00Z'),
    ),
  ).toEqual([duplicate]);
});

test('daily schedule catches up once after local configured hour', () => {
  const before = new Date(2026, 8, 20, 2);
  const after = new Date(2026, 8, 20, 4);
  expect(backupDue(3, null, before)).toBe(false);
  expect(backupDue(3, null, after)).toBe(true);
  expect(backupDue(3, new Date(2026, 8, 19, 4).toISOString(), after)).toBe(true);
  expect(backupDue(3, after.toISOString(), after)).toBe(false);
});

test('a scheduled pass does nothing while backups are disabled', async () => {
  await saveDbBackupPolicy({ ...DEFAULT_DB_BACKUP_POLICY, bucket: config.bucket, hour: 0 });
  await scheduledBackup();
  expect((await loadDbBackupSettings()).status).toBeNull();
});

test('a scheduled pass backs up once a day once the configured hour has passed', async () => {
  await saveDbBackupPolicy({
    ...DEFAULT_DB_BACKUP_POLICY,
    enabled: true,
    bucket: config.bucket,
    hour: 0,
  });
  await scheduledBackup();
  expect((await loadDbBackupSettings()).status?.state).toBe('succeeded');

  await scheduledBackup();
  expect(await backups()).toBe(1);
});

test('a scheduled pass waits an hour after a failed attempt before trying again', async () => {
  await saveDbBackupPolicy({
    ...DEFAULT_DB_BACKUP_POLICY,
    enabled: true,
    bucket: config.bucket,
    hour: 0,
  });
  uploadFails = true;
  expect(await scheduledBackup()).toBeInstanceOf(Error);
  uploadFails = false;

  await scheduledBackup();
  expect((await loadDbBackupSettings()).status?.state).toBe('failed');

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  await saveDbBackupStatus({ state: 'failed', started_at: twoHoursAgo, finished_at: twoHoursAgo });
  await scheduledBackup();
  expect((await loadDbBackupSettings()).status?.state).toBe('succeeded');
});

test('a running status only counts while its heartbeat is recent', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  expect(backupRunning(null, now)).toBe(false);
  expect(backupRunning({ state: 'running', started_at: at(30), heartbeat_at: at(1) }, now)).toBe(
    true,
  );
  expect(backupRunning({ state: 'running', started_at: at(30), heartbeat_at: at(10) }, now)).toBe(
    false,
  );
  expect(backupRunning({ state: 'running', started_at: at(30) }, now)).toBe(false);
  expect(backupRunning({ state: 'succeeded', started_at: at(1), heartbeat_at: at(1) }, now)).toBe(
    false,
  );
});

test('snapshot work leaves the event loop and shared writer responsive', async () => {
  const db = new Database(source);
  db.run('CREATE TABLE large_data (payload BLOB)');
  for (let i = 0; i < 32; i++) db.run('INSERT INTO large_data VALUES (randomblob(1048576))');
  db.close();
  const { sqlitePool } = await import('../db/sqlite/index.ts');
  let snapshotFinished = false;
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
  }, 5);
  const snapshot = createSnapshot(source, join(directory, 'large.db')).then((info) => {
    snapshotFinished = true;
    return info;
  });
  try {
    await sqlitePool().write("INSERT INTO photos VALUES (3, 'during backup')");
    expect(snapshotFinished).toBe(false);
    await snapshot;
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(interval);
  }
});

test('multipart upload completes in ordered parts and aborts after a part failure', async () => {
  const path = join(directory, 'large.gz');
  await Bun.write(path, new Uint8Array(64 * 1024 * 1024 + 1));
  const info = {
    schema: '0001-test',
    bytes: 1,
    compressed_bytes: Bun.file(path).size,
    sha256: '0'.repeat(64),
  };
  const storage = new BackupR2(config);
  const key = computeBackupKey(info.schema);
  const methods: string[] = [];
  let failPart = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    methods.push(request.method);
    if (url.searchParams.has('uploads'))
      return new Response(
        '<InitiateMultipartUploadResult><UploadId>test-id</UploadId></InitiateMultipartUploadResult>',
      );
    expect(url.searchParams.get('uploadId')).toBe('test-id');
    if (request.method === 'PUT')
      return failPart
        ? new Response(null, { status: 503 })
        : new Response(null, { headers: { etag: '"part-etag"' } });
    if (request.method === 'DELETE') return new Response(null);
    const body = await request.text();
    expect(body).toContain('<PartNumber>1</PartNumber>');
    expect(body).toContain('<PartNumber>2</PartNumber>');
    return new Response(
      '<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>',
    );
  }) as typeof fetch;
  await storage.upload(key, path, info, 'test');
  expect(methods).toEqual(['POST', 'PUT', 'PUT', 'POST']);
  methods.length = 0;
  failPart = true;
  await expect(storage.upload(key, path, info, 'test')).rejects.toThrow('503');
  expect(methods).toEqual(['POST', 'PUT', 'DELETE']);
});
