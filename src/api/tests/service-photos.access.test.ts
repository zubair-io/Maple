/**
 * `/api/service/*`: key and scope enforcement, owner isolation, and `GET /people` visibility.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { revokeServiceApiKey } from '../src/auth/service-api-keys.ts';
import { run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  createServiceFixture,
  search,
  serviceRequest,
  type ServiceFixture,
} from './helpers/service-photos-fixtures.ts';

let fx: ServiceFixture;

beforeEach(async () => {
  fx = await createServiceFixture();
});

afterEach(() => fx.close());

const DAY = '2024-07-04T10:00:00.000Z';

describe('service key enforcement', () => {
  it('answers 401 with the error shape for a missing, malformed or revoked key', async () => {
    const missing = await serviceRequest('/people', null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: 'missing_bearer',
      message: expect.any(String),
    });

    const malformed = await serviceRequest('/people', 'maple_sk_nope');
    expect(malformed.status).toBe(401);
    expect((await malformed.json()).error).toBe('invalid_key');

    const keyId = /^maple_sk_([a-f0-9]{16})_/.exec(fx.key)![1]!;
    await revokeServiceApiKey(keyId);
    const revoked = await serviceRequest('/people', fx.key);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error).toBe('revoked_key');
  });

  it('answers 403 when the key lacks the endpoint scope', async () => {
    const id = fx.photo({ capturedAt: DAY });
    const searchOnly = await fx.mintKey(['assets:search']);
    const readOnly = await fx.mintKey(['assets:read']);

    const people = await serviceRequest('/people', searchOnly);
    expect(people.status).toBe(403);
    expect(await people.json()).toMatchObject({
      error: 'insufficient_scope',
      message: expect.stringContaining('people:read'),
    });
    expect((await serviceRequest(`/photos/${id}`, searchOnly)).status).toBe(403);
    expect((await serviceRequest(`/photos/${id}/thumb`, searchOnly)).status).toBe(403);
    expect((await serviceRequest(`/photos/${id}/preview`, searchOnly)).status).toBe(403);
    expect((await search(readOnly, { from: '2024-01-01' })).status).toBe(403);

    expect((await serviceRequest(`/photos/${id}`, readOnly)).status).toBe(200);
    expect((await search(searchOnly, { from: '2024-01-01' })).status).toBe(200);
  });

  it('authenticates before reading the body', async () => {
    const response = await serviceRequest('/photos/search', null, { body: '{not json' });
    expect(response.status).toBe(401);
  });

  it('rejects malformed JSON and an unfiltered search with 400', async () => {
    const malformed = await serviceRequest('/photos/search', fx.key, { body: '{not json' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_request' });

    const unfiltered = await search(fx.key, {});
    expect(unfiltered.status).toBe(400);
    expect(unfiltered.body.error).toBe('invalid_request');
    expect((await search(fx.key, { people: [], place: '  ', limit: 5 })).status).toBe(400);
    expect((await search(fx.key, { from: '2024-01-01', limit: 0 })).status).toBe(400);
    expect((await search(fx.key, { from: '2024-01-01', limit: 101 })).status).toBe(400);
    expect((await search(fx.key, { from: '2024-02-30' })).status).toBe(400);
    expect((await search(fx.key, { from: '2024-03-02', to: '2024-03-01' })).status).toBe(400);
    expect((await search(fx.key, { people: ['not-an-id'] })).status).toBe(400);
  });
});

describe('owner isolation', () => {
  it('never returns another user’s photos, and 404s them like missing ones', async () => {
    const mine = fx.photo({ capturedAt: DAY, people: ['Ada'] });
    const theirs = fx.photo({ capturedAt: DAY, people: ['Grace'] }, fx.otherId);

    const result = await search(fx.key, { from: '2024-07-04', to: '2024-07-04' });
    expect(result.body.photos.map((photo) => photo.assetId)).toEqual([mine]);
    expect(result.body.total).toBe(1);

    for (const path of [
      `/photos/${theirs}`,
      `/photos/${theirs}/thumb`,
      `/photos/${theirs}/preview`,
    ]) {
      const response = await serviceRequest(path, fx.key);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found', message: 'No such photo.' });
    }
    expect((await serviceRequest('/photos/0123456789abcdef01234567', fx.key)).status).toBe(404);
    expect((await serviceRequest('/photos/nope', fx.key)).status).toBe(404);

    const people = (await (await serviceRequest('/people', fx.key)).json()) as {
      people: Array<{ name: string }>;
    };
    expect(people.people.map((person) => person.name)).toEqual(['Ada']);
  });

  it('scopes a key to the user who minted it', async () => {
    fx.photo({ capturedAt: DAY });
    const theirs = fx.photo({ capturedAt: DAY }, fx.otherId);
    const otherKey = await fx.mintKey(['assets:search'], fx.otherId);
    const result = await search(otherKey, { from: '2024-07-04' });
    expect(result.body.photos.map((photo) => photo.assetId)).toEqual([theirs]);
  });
});

describe('GET /api/service/people', () => {
  it('lists visible people with their photo counts, covers and auto-name flag', async () => {
    const first = fx.photo({ capturedAt: '2024-07-01T10:00:00.000Z', people: ['Ada', 'Person 7'] });
    const second = fx.photo({ capturedAt: '2024-07-02T10:00:00.000Z', people: ['Ada'] });
    fx.photo({ capturedAt: '2024-07-03T10:00:00.000Z', people: ['Ada'], hidden: true });
    run(
      fx.live.db,
      'UPDATE people SET cover_asset_id = ? WHERE id = ?',
      first,
      fx.people.get('Ada')!,
    );

    const body = (await (await serviceRequest('/people', fx.key)).json()) as { people: unknown[] };
    expect(body.people).toEqual([
      {
        id: fx.people.get('Ada'),
        name: 'Ada',
        autoNamed: false,
        photoCount: 2,
        coverAssetId: first,
      },
      {
        id: fx.people.get('Person 7'),
        name: 'Person 7',
        autoNamed: true,
        photoCount: 1,
        coverAssetId: first,
      },
    ]);
    expect(second).toBeString();
  });

  it('drops hidden, excluded and merged people, and replaces a cover the owner cannot see', async () => {
    const mine = fx.photo({
      capturedAt: DAY,
      people: ['Ada', 'Hidden', 'Excluded', 'Merged'],
    });
    const theirs = fx.photo({ capturedAt: DAY, people: ['Ada'] }, fx.otherId);
    const ada = fx.people.get('Ada')!;
    run(fx.live.db, 'UPDATE people SET cover_asset_id = ? WHERE id = ?', theirs, ada);
    run(fx.live.db, 'UPDATE people SET hidden = 1 WHERE id = ?', fx.people.get('Hidden')!);
    run(fx.live.db, 'UPDATE people SET excluded = 1 WHERE id = ?', fx.people.get('Excluded')!);
    run(
      fx.live.db,
      'UPDATE people SET merged_into = ? WHERE id = ?',
      ada,
      fx.people.get('Merged')!,
    );

    const body = (await (await serviceRequest('/people', fx.key)).json()) as {
      people: Array<{ id: string; coverAssetId: string | null }>;
    };
    // The excluded person's photo is dropped entirely, so Ada has no visible photo left either.
    expect(body.people).toEqual([]);

    const second = fx.photo({ capturedAt: '2024-07-05T10:00:00.000Z', people: ['Ada'] });
    const again = (await (await serviceRequest('/people', fx.key)).json()) as {
      people: Array<{ id: string; coverAssetId: string | null; photoCount: number }>;
    };
    expect(again.people).toEqual([
      { id: ada, name: 'Ada', autoNamed: false, photoCount: 1, coverAssetId: second },
    ] as never);
    expect(mine).toBeString();
  });
});
