import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { verifyImageCapability } from './image-capability.ts';

describe('image URL capabilities', () => {
  test('accepts only the exact image path before expiry', async () => {
    const token = randomBytes(32).toString('base64url');
    const row = {
      _id: createHash('sha256').update(token).digest('hex'),
      path: '/api/thumb/photos/a.jpg',
      purpose: 'image-read',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
    };
    const db = {
      collection: () => ({
        findOne: async (query: any) =>
          query._id === row._id && query.path === row.path && row.expires_at > query.expires_at.$gt
            ? row
            : null,
      }),
    } as any;
    expect(
      await verifyImageCapability(
        new Request(`http://maple/api/thumb/photos/a.jpg?token=${token}`),
        db,
      ),
    ).toBe(true);
    expect(
      await verifyImageCapability(
        new Request(`http://maple/api/preview/photos/a.jpg?token=${token}`),
        db,
      ),
    ).toBe(false);
    expect(
      await verifyImageCapability(new Request(`http://maple/api/assets?token=${token}`), db),
    ).toBe(false);
  });
});
