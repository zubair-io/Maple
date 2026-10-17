// #4745: operator-only routes must 403 a member before their handler runs.
// Each row is a mutating endpoint that was mounted behind requireAuth only;
// GETs on the same modules stay member-readable and are not listed.
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { purgeSubthresholdFacesRoutes } from './admin-purge-subthreshold-faces.ts';
import { apnsConfigRoutes } from './apns-config.ts';
import { changeLogGcRoutes } from './change-log-gc.ts';
import { derivativeAuditRoutes } from './derivative-audit.ts';
import { enrichmentRoutes } from './enrichment.ts';
import { mapConfigRoutes } from './map-config.ts';

type Row = {
  name: string;
  routes: Elysia;
  method: 'POST' | 'PUT';
  path: string;
  body?: unknown;
};

const rows: Row[] = [
  {
    name: 'face purge',
    routes: purgeSubthresholdFacesRoutes as unknown as Elysia,
    method: 'POST',
    path: '/api/admin/faces/purge-subthreshold?apply=true&includeAssigned=true',
  },
  {
    name: 'APNs config',
    routes: apnsConfigRoutes as unknown as Elysia,
    method: 'PUT',
    path: '/api/apns/config',
    body: { enabled: false },
  },
  {
    name: 'map config',
    routes: mapConfigRoutes as unknown as Elysia,
    method: 'PUT',
    path: '/api/map/config',
    body: { tile_url: 'https://tiles.example.invalid/{z}/{x}/{y}.png' },
  },
  {
    name: 'derivative audit config',
    routes: derivativeAuditRoutes as unknown as Elysia,
    method: 'PUT',
    path: '/api/derivative-audit/config',
    body: { enabled: false },
  },
  {
    name: 'derivative audit run',
    routes: derivativeAuditRoutes as unknown as Elysia,
    method: 'POST',
    path: '/api/derivative-audit/run',
  },
  {
    name: 'change-log GC config',
    routes: changeLogGcRoutes as unknown as Elysia,
    method: 'PUT',
    path: '/api/change-log-gc/config',
    body: { enabled: false },
  },
  {
    name: 'enrichment Nominatim test',
    routes: enrichmentRoutes as unknown as Elysia,
    method: 'POST',
    path: '/api/enrichment/test',
    body: { nominatim_url: 'http://127.0.0.1:9/' },
  },
  {
    name: 'enrichment describe test',
    routes: enrichmentRoutes as unknown as Elysia,
    method: 'POST',
    path: '/api/enrichment/test-describe',
    body: { provider: 'ollama', url: 'http://127.0.0.1:9/' },
  },
];

function request(row: Row): Request {
  const init: RequestInit = { method: row.method };
  if (row.body !== undefined) {
    init.body = JSON.stringify(row.body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(`http://localhost${row.path}`, init);
}

describe('operator-only routes reject members (#4745)', () => {
  for (const row of rows) {
    test(`${row.name}: member gets 403`, async () => {
      const app = new Elysia().use(fakeAuth({ role: 'member' })).use(row.routes);
      const res = await app.handle(request(row));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'owner role required' });
    });
  }
});
