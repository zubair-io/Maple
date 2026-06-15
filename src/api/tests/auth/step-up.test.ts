/**
 * Step-up re-auth enforcement (#861).
 *
 * Sensitive actions (add/remove credential, create/rescind invite) require a
 * fresh WebAuthn step-up token in `X-Step-Up`, not just a valid access token —
 * so a leaked short-lived access token can't escalate into persistent access.
 */
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../../src/index.ts';
import { signAccessToken, signStepUpToken } from '../../src/auth/tokens.ts';
import { usersCollection } from '../../src/db/client.ts';

const app = buildApp({ stageNames: [] });
const SECRET = process.env.MAPLE_JWT_SECRET!;
const EMAIL = 'owner@maple.test';

let ownerId: ObjectId;
let bearer: string;

beforeEach(async () => {
  const users = await usersCollection();
  await users.deleteMany({});
  const ins = await users.insertOne({
    email: EMAIL,
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  ownerId = ins.insertedId;
  bearer = await signAccessToken(
    { sub: ownerId.toHexString(), email: EMAIL, role: 'owner' },
    SECRET,
  );
});

function req(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

// Each sensitive route with a schema-valid body, so a rejection is the step-up
// gate (403), not body validation.
const SENSITIVE: ReadonlyArray<readonly [string, string, unknown]> = [
  ['POST', '/api/auth/invites', { email: 'invitee@maple.test' }],
  ['DELETE', '/api/auth/invites/some-code', undefined],
  ['POST', '/api/auth/credentials/verify', { credential: {}, device_label: 'x' }],
  ['DELETE', `/api/auth/credentials/${new ObjectId().toHexString()}`, undefined],
];

describe('step-up enforcement (#861)', () => {
  for (const [method, path, body] of SENSITIVE) {
    it(`${method} ${path} rejects a valid access token without step-up (403)`, async () => {
      const res = await req(method, path, { authorization: `Bearer ${bearer}` }, body);
      expect(res.status).toBe(403);
    });
  }

  it('accepts a sensitive action with a fresh step-up token', async () => {
    const stepUp = await signStepUpToken(ownerId.toHexString(), SECRET);
    const res = await req(
      'POST',
      '/api/auth/invites',
      { authorization: `Bearer ${bearer}`, 'x-step-up': stepUp },
      { email: 'invitee@maple.test' },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBeDefined();
  });

  it('rejects a malformed step-up token', async () => {
    const res = await req(
      'POST',
      '/api/auth/invites',
      { authorization: `Bearer ${bearer}`, 'x-step-up': 'not-a-token' },
      { email: 'invitee@maple.test' },
    );
    expect(res.status).toBe(403);
  });

  it('rejects a step-up token minted for a different user', async () => {
    const otherStepUp = await signStepUpToken(new ObjectId().toHexString(), SECRET);
    const res = await req(
      'POST',
      '/api/auth/invites',
      { authorization: `Bearer ${bearer}`, 'x-step-up': otherStepUp },
      { email: 'invitee@maple.test' },
    );
    expect(res.status).toBe(403);
  });
});
