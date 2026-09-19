/**
 * Route-integration test: GET/PUT /api/display/config.
 *
 * The `display` row of `app_settings`, reached through `readAppSettings` /
 * `patchAppSettings` (#3787). The route resolves the process-wide SQLite
 * handle, so each test installs a private database as that handle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { displayRoutes } from './display.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('/api/display/config', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
  });

  afterEach(() => {
    live.close();
  });

  function app() {
    return new Elysia().use(displayRoutes);
  }

  it('GET /api/display/config returns defaults', async () => {
    const res = await app().handle(new Request('http://localhost/api/display/config'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { show_hidden_images: boolean };
    expect(body.show_hidden_images).toBe(false);
  });

  it('PUT /api/display/config updates config', async () => {
    const res1 = await app().handle(
      new Request('http://localhost/api/display/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_hidden_images: true }),
      }),
    );
    expect(res1.status).toBe(200);

    const res2 = await app().handle(new Request('http://localhost/api/display/config'));
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { show_hidden_images: boolean };
    expect(body.show_hidden_images).toBe(true);
  });
});
