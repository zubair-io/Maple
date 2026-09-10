import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Elysia } from 'elysia';
import { getDb, closeDb } from '../db/client.ts';
import { ManagedHttps } from './managed-https.ts';
import {
  DEFAULT_HTTPS,
  loadHttpsConfig,
  saveHttpsConfig,
  publicHttpsConfig,
  validateHttpsConfig,
} from './managed-https-config.ts';
import { writeCertificateState, readCertificateState, renewalTime } from './certificate-store.ts';
import * as issuer from './issue-certificate.ts';
import { CloudflareDns } from './cloudflare-dns.ts';
import { managedHttpsRoutes } from '../routes/managed-https.ts';
import { signAccessToken } from '../auth/tokens.ts';

const config = {
  ...DEFAULT_HTTPS,
  enabled: true,
  hostname: 'local.example.com',
  email: 'owner@example.com',
  zone_id: 'a'.repeat(32),
  api_token: 'test-only-token',
  terms_agreed: true,
  revision: 'first',
};
const certificate = {
  hostname: config.hostname,
  cert: 'certificate-one',
  key: 'private-key',
  not_before: Date.now() - 86400_000,
  not_after: Date.now() + 60 * 86400_000,
};

describe('managed HTTPS settings and lifecycle', () => {
  let mongo: MongoMemoryServer;
  let manager: ManagedHttps;
  let originalEnv: { uri: string | undefined; db: string | undefined; jwt: string | undefined };
  let issued: ReturnType<typeof spyOn<typeof issuer, 'issueCertificate'>>;
  beforeAll(async () => {
    originalEnv = {
      uri: process.env.MAPLE_MONGO_URI,
      db: process.env.MAPLE_MONGO_DB,
      jwt: process.env.MAPLE_JWT_SECRET,
    };
    issued = spyOn(issuer, 'issueCertificate');
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    process.env.MAPLE_MONGO_URI = mongo.getUri();
    process.env.MAPLE_MONGO_DB = `managed_https_test_${process.pid}`;
    process.env.MAPLE_JWT_SECRET = 'managed-https-test-signing-value';
  }, 60_000);
  beforeEach(async () => {
    await (await getDb()).dropDatabase();
    manager = new ManagedHttps();
    issued.mockReset();
    issued.mockResolvedValue(certificate);
  });
  afterEach(() => manager.stop());
  afterAll(async () => {
    issued.mockRestore();
    await closeDb();
    await mongo?.stop();
    for (const [key, value] of Object.entries({
      MAPLE_MONGO_URI: originalEnv.uri,
      MAPLE_MONGO_DB: originalEnv.db,
      MAPLE_JWT_SECRET: originalEnv.jwt,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('validates hostname, port and consent without exposing the DNS token', () => {
    expect(validateHttpsConfig(config)).toBeNull();
    for (const hostname of [
      '192.168.1.1',
      'https://local.example.com',
      'local',
      '*.example.com',
      'x.example.com/path',
      'x@evil.com',
    ]) {
      expect(validateHttpsConfig({ ...config, hostname })).not.toBeNull();
    }
    expect(validateHttpsConfig({ ...config, port: 3000 })).not.toBeNull();
    expect(validateHttpsConfig({ ...config, terms_agreed: false })).not.toBeNull();
    expect(publicHttpsConfig(config)).not.toHaveProperty('api_token');
    expect(publicHttpsConfig(config).api_token_set).toBe(true);
  });

  it('issues once, persists the account result and starts the hostname listener', async () => {
    await saveHttpsConfig(config);
    const listening: number[] = [];
    manager.start((cfg) => {
      listening.push(cfg.port);
      return { stop() {} };
    });
    await manager.refresh();
    await manager.refresh();
    expect(issued).toHaveBeenCalledTimes(1);
    expect(listening).toEqual([3443]);
    expect((await readCertificateState())?.certificate).toEqual(certificate);
    expect(manager.endpoint()).toEqual({ ip: config.hostname, port: 3443, scheme: 'https' });
    expect(manager.status().state).toBe('ready');
  });

  it('starts from a persisted certificate without reissuing and applies runtime port changes', async () => {
    await saveHttpsConfig(config);
    await writeCertificateState({ certificate });
    const stopped: number[] = [];
    manager.start((cfg) => ({
      stop: () => {
        stopped.push(cfg.port);
      },
    }));
    await manager.refresh();
    await saveHttpsConfig({ ...config, port: 4443 });
    await manager.refresh();
    expect(issued).not.toHaveBeenCalled();
    expect(stopped).toEqual([3443]);
    expect(manager.endpoint()?.port).toBe(4443);
    await saveHttpsConfig({ ...config, enabled: false });
    await manager.refresh();
    expect(manager.endpoint()).toBeNull();
    expect(stopped).toEqual([3443, 4443]);
  });

  it('keeps a valid certificate serving during failed renewal and persists retry backoff', async () => {
    const expiring = {
      ...certificate,
      not_before: Date.now() - 80 * 86400_000,
      not_after: Date.now() + 10 * 86400_000,
    };
    await saveHttpsConfig(config);
    await writeCertificateState({ certificate: expiring });
    issued.mockRejectedValue(new Error('sensitive provider request payload'));
    manager.start(() => ({ stop() {} }));
    await manager.refresh();
    await manager.refresh();
    expect(issued).toHaveBeenCalledTimes(1);
    expect(manager.endpoint()).not.toBeNull();
    expect(manager.status().state).toBe('error');
    expect(JSON.stringify(manager.status())).not.toContain('sensitive');
    expect((await readCertificateState())?.retry_after).toBeGreaterThan(Date.now());
  });

  it('does not advertise expired certificates or failed initial issuance', async () => {
    await saveHttpsConfig(config);
    await writeCertificateState({ certificate: { ...certificate, not_after: Date.now() - 1000 } });
    issued.mockRejectedValue(new Error('unavailable'));
    manager.start(() => {
      throw new Error('must not bind expired certificate');
    });
    await manager.refresh();
    expect(manager.endpoint()).toBeNull();
    expect(manager.status().state).toBe('error');
  });

  it('retries orphaned DNS cleanup without placing another certificate order', async () => {
    await saveHttpsConfig(config);
    await writeCertificateState({
      certificate,
      challenges: [{ zone_id: config.zone_id, id: 'b'.repeat(32) }],
    });
    const remove = spyOn(CloudflareDns.prototype, 'remove').mockRejectedValue(
      new Error('DNS unavailable'),
    );
    try {
      manager.start(() => ({ stop() {} }));
      await manager.refresh();
      expect(manager.endpoint()).not.toBeNull();
      expect(manager.status().error).toContain('cleanup failed');
      remove.mockResolvedValue(undefined);
      await manager.refresh();
      expect((await readCertificateState())?.challenges).toEqual([]);
      expect(issued).not.toHaveBeenCalled();
    } finally {
      remove.mockRestore();
    }
  });

  it('restores the previous listener when a new port cannot bind', async () => {
    await saveHttpsConfig(config);
    await writeCertificateState({ certificate });
    const ports: number[] = [];
    manager.start((cfg) => {
      if (cfg.port === 4443) throw new Error('occupied port');
      ports.push(cfg.port);
      return { stop() {} };
    });
    await manager.refresh();
    await saveHttpsConfig({ ...config, port: 4443 });
    await manager.refresh();
    expect(manager.endpoint()?.port).toBe(3443);
    expect(ports).toEqual([3443, 3443]);
    expect(manager.status().state).toBe('error');
  });

  it('renews short-lived certificates based on their actual lifetime', () => {
    expect(renewalTime({ ...certificate, not_before: 0, not_after: 6 * 86400_000 })).toBe(
      4 * 86400_000,
    );
  });

  it('owner-gates credential settings, preserves blank tokens, and redacts responses', async () => {
    const app = new Elysia().use(managedHttpsRoutes).get('/health', () => 'public');
    expect((await app.handle(new Request('http://localhost/health'))).status).toBe(200);
    const member = await signAccessToken(
      { sub: 'member', email: 'm@example.com', role: 'member', file_access: false },
      process.env.MAPLE_JWT_SECRET!,
    );
    const owner = await signAccessToken(
      { sub: 'owner', email: 'o@example.com', role: 'owner', file_access: true },
      process.env.MAPLE_JWT_SECRET!,
    );
    const request = (method: string, token?: string, body?: object) =>
      app.handle(
        new Request('http://localhost/api/network/https/', {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    expect((await request('GET')).status).toBe(401);
    expect((await request('PUT', member, config)).status).toBe(403);
    const saved = await request('PUT', owner, config);
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('test-only-token');
    const revision = (await loadHttpsConfig()).revision;
    expect((await request('PUT', owner, { ...config, api_token: '' })).status).toBe(200);
    expect((await loadHttpsConfig()).api_token).toBe(config.api_token);
    expect((await loadHttpsConfig()).revision).toBe(revision);
    expect(
      (await request('PUT', owner, { ...config, enabled: false, api_token: null })).status,
    ).toBe(200);
    expect((await loadHttpsConfig()).api_token).toBe('');
  });
});
