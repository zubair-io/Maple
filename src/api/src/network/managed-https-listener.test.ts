import { afterAll, beforeAll, expect, it } from 'bun:test';
// Temporary OpenSSL fixture files only; never writes originals or sidecars.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { httpsListenerFactory } from './managed-https-listener.ts';
import { DEFAULT_HTTPS } from './managed-https-config.ts';
import type { StoredCertificate } from './certificate-store.ts';

let temp: string;
let cert: StoredCertificate;
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'maple-https-'));
  const command = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(temp, 'key.pem'),
      '-out',
      join(temp, 'cert.pem'),
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  expect(await command.exited).toBe(0);
  cert = {
    hostname: 'localhost',
    key: await Bun.file(join(temp, 'key.pem')).text(),
    cert: await Bun.file(join(temp, 'cert.pem')).text(),
    not_before: Date.now(),
    not_after: Date.now() + 86400_000,
  };
});
afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

it('serves TCP HTTPS and HTTP/3, replaces certificates, and leaves the IP listener intact', async () => {
  // Older installed developer runtimes cannot exercise QUIC; deployments are
  // pinned to 1.4.2. This test intentionally fails rather than silently skipping.
  expect(Bun.semver.order(Bun.version, '1.4.2')).toBeGreaterThanOrEqual(0);
  const plain = Bun.serve({ port: 0, fetch: () => new Response('ip fallback') });
  const app = new Elysia().get('/probe', () => 'secure');
  const start = httpsListenerFactory(() => app as unknown as Elysia);
  const listener = start({ ...DEFAULT_HTTPS, port: 0, http3: true }, cert);
  const port = app.server!.port;
  try {
    const tcpOptions = {
      tls: { rejectUnauthorized: false },
      protocol: 'http1.1',
      signal: AbortSignal.timeout(5000),
    };
    const tcp = await fetch(`https://localhost:${port}/probe`, tcpOptions);
    expect(await tcp.text()).toBe('secure');
    expect(tcp.headers.get('alt-svc')).toContain('h3');
    const quicOptions = {
      tls: { rejectUnauthorized: false },
      protocol: 'http3',
      signal: AbortSignal.timeout(5000),
    };
    const quic = await fetch(`https://localhost:${port}/probe`, quicOptions);
    expect(await quic.text()).toBe('secure');
    listener.stop();
    const replacement = new Elysia().get('/probe', () => 'renewed');
    const next = httpsListenerFactory(() => replacement as unknown as Elysia)(
      { ...DEFAULT_HTTPS, port: port!, http3: false },
      cert,
    );
    try {
      expect(
        await (
          await fetch(`https://localhost:${port}/probe`, { ...tcpOptions, keepalive: false })
        ).text(),
      ).toBe('renewed');
      expect(await (await fetch(`http://localhost:${plain.port}`)).text()).toBe('ip fallback');
    } finally {
      next.stop();
    }
  } finally {
    listener.stop();
    await plain.stop(true);
  }
}, 20_000);
