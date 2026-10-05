import { expect, test } from 'bun:test';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { loadPublicOrigin } from './public-origin.ts';
import { saveNetworkConfig } from './network-config.repo.ts';
import { DEFAULT_HTTPS, saveHttpsConfig } from './managed-https-config.ts';

test('browser-facing reverse proxy origin takes precedence over the managed listener', async () => {
  using _live = await createLiveTestDatabase();
  await saveHttpsConfig({
    ...DEFAULT_HTTPS,
    enabled: true,
    hostname: 'listener.example.com',
    port: 3443,
  });
  await saveNetworkConfig({ public_origin: 'https://photos.example.com' });
  expect(await loadPublicOrigin()).toBe('https://photos.example.com');
  await saveNetworkConfig({ public_origin: 'http://localhost:3000' });
  expect(await loadPublicOrigin()).toBe('http://localhost:3000');
});

test('clearing the public origin uses an enabled managed listener with its actual port', async () => {
  using _live = await createLiveTestDatabase();
  expect(await loadPublicOrigin()).toBeNull();
  await saveHttpsConfig({
    ...DEFAULT_HTTPS,
    enabled: true,
    hostname: 'photos.example.com',
    port: 3443,
  });
  expect(await loadPublicOrigin()).toBe('https://photos.example.com:3443');
  await saveNetworkConfig({ public_origin: 'https://proxy.example.com' });
  await saveNetworkConfig({ public_origin: null });
  await saveHttpsConfig({
    ...DEFAULT_HTTPS,
    enabled: true,
    hostname: 'photos.example.com',
    port: 443,
  });
  expect(await loadPublicOrigin()).toBe('https://photos.example.com');
  await saveHttpsConfig({ ...DEFAULT_HTTPS, enabled: false, hostname: 'photos.example.com' });
  expect(await loadPublicOrigin()).toBeNull();
  await saveHttpsConfig({ ...DEFAULT_HTTPS, enabled: true });
  expect(await loadPublicOrigin()).toBeNull();
});

test('an invalid persisted public origin fails closed rather than falling back to another authority', async () => {
  using _live = await createLiveTestDatabase();
  await saveHttpsConfig({ ...DEFAULT_HTTPS, enabled: true, hostname: 'listener.example.com' });
  await saveNetworkConfig({ public_origin: 'http://192.168.1.4:3000' });
  await expect(loadPublicOrigin()).rejects.toThrow('HTTP is allowed only for loopback');
});
