import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { setupAuditMongo } from '../workers/derivative-audit/test-support.ts';
import { derivativeAuditRoutes } from './derivative-audit.ts';

const h = setupAuditMongo(`maple_derivative_audit_route_test_${process.pid}`);
const app = new Elysia().use(derivativeAuditRoutes);

describe('derivative-audit routes', () => {
  it('GET /status returns config + progress', async () => {
    if (!h.mongoReachable) return;
    const res = await app.handle(new Request('http://localhost/api/derivative-audit/status'));
    const body = (await res.json()) as {
      config: { enabled: boolean };
      progress: { scanned: number };
    };
    expect(body.config.enabled).toBe(true);
    expect(body.progress).toHaveProperty('scanned');
  });

  it('PUT /config persists a partial patch', async () => {
    if (!h.mongoReachable) return;
    const res = await app.handle(
      new Request('http://localhost/api/derivative-audit/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, deep_r2_enabled: false }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; config: { enabled: boolean } };
    expect(body.config.enabled).toBe(false);

    const check = await app.handle(new Request('http://localhost/api/derivative-audit/status'));
    const checkBody = (await check.json()) as { config: { enabled: boolean } };
    expect(checkBody.config.enabled).toBe(false);
  });
});
