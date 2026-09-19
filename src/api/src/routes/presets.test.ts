/**
 * Route-integration test: /api/presets CRUD (#1115).
 *
 * Covers the preset list/create/delete cycle, duplicate-name 409s, and the
 * passthrough rule (unknown `fields` keys AND unknown top-level keys from
 * newer schema versions round-trip byte-identically).
 *
 * The handlers reach `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the duration of the block —
 * `createLiveTestDatabase`, not `createTestDatabase`. Nothing external is
 * required and nothing is skipped.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { presetsRoutes } from './presets.ts';

interface WirePreset {
  id: string;
  schemaVersion: number;
  name: string;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

describe('/api/presets', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
  });

  // Closing in `afterEach` rather than at the head of the next `beforeEach`:
  // the last test's database has no successor to close it, so the paired form
  // left this suite's handle installed process-wide for the rest of the run.
  // Bun runs every test file in one process, so a suite later in the run that
  // asserts no database is open (`preview-ondemand-limiter.test.ts`, which
  // pins the gate keeping a pre-startup request off an absent pool) saw this
  // one's and failed — in the full run only, which is what made it look like
  // the limiter's problem rather than this suite's.
  afterEach(() => {
    live?.close();
  });

  // No explicit `: Elysia` return type — the routed sub-app's generic
  // doesn't satisfy the bare `Elysia` default (same Elysia-generics quirk
  // as `buildApp` in index.ts); inference keeps tsc clean here.
  function app() {
    return new Elysia().use(presetsRoutes);
  }

  function create(body: unknown): Promise<Response> {
    return app().handle(
      new Request('http://localhost/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  function list(): Promise<Response> {
    return app().handle(new Request('http://localhost/api/presets'));
  }

  function del(id: string): Promise<Response> {
    return app().handle(new Request(`http://localhost/api/presets/${id}`, { method: 'DELETE' }));
  }

  it('creates a preset and lists it back', async () => {
    const res = await create({
      schemaVersion: 1,
      name: 'My Sunset',
      fields: { contrast: -25, saturation: 15, profile: 'Neutral' },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as WirePreset;
    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
    expect(created.schemaVersion).toBe(1);
    expect(created.name).toBe('My Sunset');
    expect(created.fields).toEqual({ contrast: -25, saturation: 15, profile: 'Neutral' });

    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(1);
    expect(listed.presets[0]!.id).toBe(created.id);
    expect(listed.presets[0]!.fields).toEqual(created.fields);
  });

  it('sorts the list by name (case-insensitive)', async () => {
    await create({ schemaVersion: 1, name: 'zebra', fields: {} });
    await create({ schemaVersion: 1, name: 'Alpha', fields: {} });
    await create({ schemaVersion: 1, name: 'mango', fields: {} });
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets.map((p) => p.name)).toEqual(['Alpha', 'mango', 'zebra']);
  });

  it('preserves unknown fields AND unknown top-level keys (passthrough)', async () => {
    const res = await create({
      schemaVersion: 3,
      name: 'From The Future',
      fields: { contrast: 10, future_curve_strength: 0.5, future_mode: 'Soft' },
      futureTopLevel: { anything: ['goes', 1] },
    });
    expect(res.status).toBe(201);
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(1);
    const row = listed.presets[0]!;
    expect(row.schemaVersion).toBe(3);
    expect(row.fields).toEqual({
      contrast: 10,
      future_curve_strength: 0.5,
      future_mode: 'Soft',
    });
    expect(row.futureTopLevel).toEqual({ anything: ['goes', 1] });
  });

  it('rejects duplicate names with 409 (case-insensitive)', async () => {
    const first = await create({ schemaVersion: 1, name: 'Flat Light', fields: {} });
    expect(first.status).toBe(201);
    const dupe = await create({ schemaVersion: 1, name: 'flat light', fields: {} });
    expect(dupe.status).toBe(409);
    const body = (await dupe.json()) as { error: string };
    expect(body.error).toContain('already exists');
  });

  it('rejects invalid documents with 400', async () => {
    // Out-of-range known field.
    expect((await create({ schemaVersion: 1, name: 'x', fields: { contrast: 500 } })).status).toBe(
      400,
    );
    // Wrong-typed known field.
    expect(
      (await create({ schemaVersion: 1, name: 'x', fields: { contrast: 'red' } })).status,
    ).toBe(400);
    // Non-scalar unknown field.
    expect(
      (await create({ schemaVersion: 1, name: 'x', fields: { future: { a: 1 } } })).status,
    ).toBe(400);
    // Whitespace-only name.
    expect((await create({ schemaVersion: 1, name: '   ', fields: {} })).status).toBe(400);
    // Bad schema version.
    expect((await create({ schemaVersion: 0, name: 'x', fields: {} })).status).toBe(400);
    // Nothing got stored.
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(0);
  });

  it('rejects document-unsafe keys with 400 instead of a 500 at insert', async () => {
    // Dotted / $-prefixed `fields` keys.
    expect((await create({ schemaVersion: 1, name: 'x', fields: { 'bad.dot': 1 } })).status).toBe(
      400,
    );
    expect((await create({ schemaVersion: 1, name: 'x', fields: { $bad: 1 } })).status).toBe(400);
    // Dotted / $-prefixed unknown TOP-LEVEL keys (preserved into `extra`).
    expect(
      (await create({ schemaVersion: 1, name: 'x', fields: {}, 'bad.dot': true })).status,
    ).toBe(400);
    expect((await create({ schemaVersion: 1, name: 'x', fields: {}, $bad: true })).status).toBe(
      400,
    );
    // Unsafe key NESTED inside a preserved value.
    expect(
      (await create({ schemaVersion: 1, name: 'x', fields: {}, future: { deep: [{ $no: 1 }] } }))
        .status,
    ).toBe(400);
    // Nothing got stored.
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(0);
  });

  it('deletes a preset (and 404s on a second delete)', async () => {
    const created = (await (
      await create({ schemaVersion: 1, name: 'Doomed', fields: { exposure: 1 } })
    ).json()) as WirePreset;
    const res = await del(created.id);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    const again = await del(created.id);
    expect(again.status).toBe(404);
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(0);
  });

  it('rejects malformed preset ids with 400', async () => {
    expect((await del('not-an-id')).status).toBe(400);
  });
});
