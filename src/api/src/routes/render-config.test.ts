/**
 * Route-integration test: GET/PUT /api/render/config.
 *
 * The `render` row of `app_settings`, reached through `readAppSettings` /
 * `patchAppSettings` (#3787). The last case asserts on the stored document
 * directly — it is the one that pins *where* the knob is persisted, so it reads
 * the settings row rather than going back through the route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { renderConfigRoutes } from './render-config.ts';
import { readAppSettings } from '../db/sqlite/repos/app-settings.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

interface ResolvedBody {
  gpu_live_render_enabled: boolean;
  source: { gpu_live_render_enabled: 'db' | 'default' };
}

describe('/api/render/config', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
  });

  afterEach(() => {
    live.close();
  });

  function app() {
    return new Elysia().use(renderConfigRoutes);
  }

  async function getConfig(): Promise<ResolvedBody> {
    const res = await app().handle(new Request('http://localhost/api/render/config'));
    expect(res.status).toBe(200);
    return (await res.json()) as ResolvedBody;
  }

  async function putConfig(body: unknown): Promise<Response> {
    return app().handle(
      new Request('http://localhost/api/render/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('GET returns the default (GPU live render on) on a fresh database', async () => {
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(true);
    expect(body.source.gpu_live_render_enabled).toBe('default');
  });

  it('PUT false kills GPU live render and GET reports it as db-sourced', async () => {
    const res = await putConfig({ gpu_live_render_enabled: false });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as ResolvedBody;
    expect(saved.gpu_live_render_enabled).toBe(false);

    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(false);
    expect(body.source.gpu_live_render_enabled).toBe('db');
  });

  it('PUT true ramps it back on', async () => {
    await putConfig({ gpu_live_render_enabled: false });
    await putConfig({ gpu_live_render_enabled: true });
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(true);
    expect(body.source.gpu_live_render_enabled).toBe('db');
  });

  it('PUT null clears the saved value back to the default', async () => {
    await putConfig({ gpu_live_render_enabled: false });
    await putConfig({ gpu_live_render_enabled: null });
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(true);
    expect(body.source.gpu_live_render_enabled).toBe('default');
  });

  it('PUT with the field omitted leaves the saved value alone', async () => {
    await putConfig({ gpu_live_render_enabled: false });
    const res = await putConfig({});
    expect(res.status).toBe(200);
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(false);
  });

  it('persists to the app_settings row named "render"', async () => {
    await putConfig({ gpu_live_render_enabled: false });
    const doc = await readAppSettings<{ config: { gpu_live_render_enabled: boolean } }>('render');
    expect(doc).not.toBeNull();
    expect(doc?.config.gpu_live_render_enabled).toBe(false);
  });
});
