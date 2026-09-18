/**
 * DB-backed Cloudflare config repo, against a per-test SQLite database.
 *
 * The repo's two persistence functions take no database argument, so the tests
 * that exercise them install the database as the process-wide handle
 * (`createLiveTestDatabase`) rather than passing an override.
 */

import { describe, expect, it } from 'bun:test';
import {
  isCloudflareConfigComplete,
  loadCloudflareConfig,
  resolveCloudflareConfig,
  saveCloudflareConfig,
  toPublicCloudflareConfig,
} from './cloudflare-config.repo.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('cloudflare-config.repo', () => {
  it('returns null when no row exists yet', async () => {
    using _live = await createLiveTestDatabase();
    expect(await loadCloudflareConfig()).toBeNull();
  });

  it('save/load round-trips a full config', async () => {
    using _live = await createLiveTestDatabase();
    await saveCloudflareConfig({
      enabled: true,
      account_id: 'acct123',
      bucket: 'maple-thumbs',
      access_key_id: 'AKIA...',
      secret_access_key: 'shh',
    });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.enabled).toBe(true);
    expect(loaded?.account_id).toBe('acct123');
    expect(loaded?.bucket).toBe('maple-thumbs');
    expect(loaded?.access_key_id).toBe('AKIA...');
    expect(loaded?.secret_access_key).toBe('shh');
  });

  it('partial patches only touch the supplied fields', async () => {
    using _live = await createLiveTestDatabase();
    await saveCloudflareConfig({
      enabled: true,
      account_id: 'acct123',
      bucket: 'maple-thumbs',
      access_key_id: 'AKIA...',
      secret_access_key: 'shh',
    });
    await saveCloudflareConfig({ enabled: false });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.enabled).toBe(false);
    // Untouched fields survive the partial patch.
    expect(loaded?.account_id).toBe('acct123');
    expect(loaded?.secret_access_key).toBe('shh');
  });

  it('omitting secret_access_key from a patch leaves the saved value unchanged', async () => {
    using _live = await createLiveTestDatabase();
    await saveCloudflareConfig({ secret_access_key: 'original-secret' });
    await saveCloudflareConfig({ bucket: 'renamed-bucket' });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.secret_access_key).toBe('original-secret');
    expect(loaded?.bucket).toBe('renamed-bucket');
  });

  it('an explicit null clears secret_access_key', async () => {
    using _live = await createLiveTestDatabase();
    await saveCloudflareConfig({ secret_access_key: 'original-secret' });
    await saveCloudflareConfig({ secret_access_key: null });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.secret_access_key).toBeNull();
  });
});

describe('resolveCloudflareConfig', () => {
  it('falls back to defaults when the DB row is null', () => {
    const resolved = resolveCloudflareConfig(null);
    expect(resolved.enabled).toBe(false);
    expect(resolved.account_id).toBeNull();
    expect(resolved.bucket).toBeNull();
    expect(resolved.access_key_id).toBeNull();
    expect(resolved.secret_access_key).toBeNull();
  });

  it('passes through DB values when present', () => {
    const resolved = resolveCloudflareConfig({
      enabled: true,
      account_id: 'a',
      bucket: 'b',
      access_key_id: 'c',
      secret_access_key: 'd',
    });
    expect(resolved).toMatchObject({
      enabled: true,
      account_id: 'a',
      bucket: 'b',
      access_key_id: 'c',
      secret_access_key: 'd',
    });
  });
});

describe('isCloudflareConfigComplete', () => {
  it('is false when disabled even with full credentials', () => {
    expect(
      isCloudflareConfigComplete({
        enabled: false,
        account_id: 'a',
        bucket: 'b',
        access_key_id: 'c',
        secret_access_key: 'd',
      }),
    ).toBe(false);
  });

  it('is false when enabled but missing any credential field', () => {
    expect(
      isCloudflareConfigComplete({
        enabled: true,
        account_id: 'a',
        bucket: null,
        access_key_id: 'c',
        secret_access_key: 'd',
      }),
    ).toBe(false);
  });

  it('is true when enabled with every credential field set', () => {
    expect(
      isCloudflareConfigComplete({
        enabled: true,
        account_id: 'a',
        bucket: 'b',
        access_key_id: 'c',
        secret_access_key: 'd',
      }),
    ).toBe(true);
  });
});

describe('toPublicCloudflareConfig', () => {
  it('redacts the secret to a boolean and keeps everything else', () => {
    const pub = toPublicCloudflareConfig({
      enabled: true,
      account_id: 'a',
      bucket: 'b',
      access_key_id: 'c',
      secret_access_key: 'shh',
    });
    expect(pub).not.toHaveProperty('secret_access_key');
    expect(pub.secret_access_key_set).toBe(true);
    expect(pub.account_id).toBe('a');
  });

  it('reports secret_access_key_set: false when unset', () => {
    const pub = toPublicCloudflareConfig({
      enabled: false,
      account_id: null,
      bucket: null,
      access_key_id: null,
      secret_access_key: null,
    });
    expect(pub.secret_access_key_set).toBe(false);
  });
});
