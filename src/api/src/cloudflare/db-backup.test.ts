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
} from './backup-retain-config.ts';
import { backupDue, backupRunning, startDbBackup, stopDbBackupScheduler } from './db-backup.ts';
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (request.method === 'PUT') {
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

afterEach(async () => {
  await stopDbBackupScheduler();
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

test('single-flight backup records failure without pruning and allows retry', async () => {
  uploadFails = true;
  expect(startDbBackup()).toBe(true);
  expect(startDbBackup()).toBe(false);
  await stopDbBackupScheduler();
  expect(backupRunning()).toBe(false);
  expect((await loadDbBackupSettings()).status?.state).toBe('failed');
  expect(deletes).toBe(0);
  uploadFails = false;
  expect(startDbBackup()).toBe(true);
  await stopDbBackupScheduler();
  const settings = await loadDbBackupSettings();
  expect(settings.status?.state).toBe('succeeded');
  expect(settings.last_success_at).toBeTruthy();
  expect(settings.status?.bytes).toBeGreaterThan(0);
  expect(await new BackupR2(config).list()).toEqual([settings.status!.key!]);
});

test('corrupt download prevents pruning and restore publication', async () => {
  corruptDownload = true;
  startDbBackup();
  await stopDbBackupScheduler();
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
