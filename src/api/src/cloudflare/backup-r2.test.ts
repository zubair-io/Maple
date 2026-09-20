import { afterEach, expect, test } from 'bun:test';
import { BackupR2 } from './backup-r2.ts';
import { computeBackupKey } from './backup-key.ts';

const originalFetch = globalThis.fetch;
const storage = new BackupR2({
  account_id: 'test',
  bucket: 'backup',
  access_key_id: 'test',
  secret_access_key: 'test',
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const key = computeBackupKey('0001-test', new Date('2026-09-20T03:00:00Z'));

test('ListObjectsV2 follows escaped continuation tokens and filters unrelated keys', async () => {
  const tokens: (string | null)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    tokens.push(url.searchParams.get('continuation-token'));
    expect(url.searchParams.get('prefix')).toBe('backups/sqlite/');
    return new Response(
      tokens.length === 1
        ? `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken><Contents><Key>${key}.verified</Key></Contents><Contents><Key>${key}</Key></Contents></ListBucketResult>`
        : '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>thumbs/image</Key></Contents></ListBucketResult>',
    );
  }) as typeof fetch;
  expect(await storage.list()).toEqual([key]);
  expect(tokens).toEqual([null, 'a&b']);
});

test('listing refuses missing or repeated continuation tokens', async () => {
  globalThis.fetch = (async () =>
    new Response(
      '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
    )) as typeof fetch;
  await expect(storage.list()).rejects.toThrow('continuation');
});

test('DeleteObjects sends Content-MD5 and detects per-object failures inside HTTP 200', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    expect(request.headers.get('content-md5')).toBeTruthy();
    expect(await request.text()).toContain(key);
    return new Response('<DeleteResult><Error><Code>AccessDenied</Code></Error></DeleteResult>');
  }) as typeof fetch;
  await expect(storage.delete([key])).rejects.toThrow('expired backups');
  await expect(storage.delete(['thumbs/image'])).rejects.toThrow('non-backup');
});

test('R2 transport errors contain no credential or response-body secrets', async () => {
  globalThis.fetch = (async () => new Response('secret response', { status: 403 })) as typeof fetch;
  await expect(storage.download(key)).rejects.toThrow('R2 GET failed (403)');
  await expect(storage.download('backups/sqlite/../../private')).rejects.toThrow('Invalid');
});
