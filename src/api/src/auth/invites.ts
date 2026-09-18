import type { ObjectId } from 'mongodb';
import { invitesCollection } from '../db/client.ts';
import { assertInviteRedeemable, generateInviteCode, INVITE_TTL_MS } from './invite-code.ts';
import type { InviteDoc } from '../db/schema.ts';

// The alphabet, the generator and the lifetime moved to `./invite-code.ts`
// when the SQLite port (#3751) needed the same three — a code minted from one
// alphabet and read back against another is a support ticket, not a bug report.

export async function createInvite(
  invitedBy: ObjectId,
  email: string,
): Promise<InviteDoc & { code: string; expires_at: Date }> {
  const c = await invitesCollection();
  const code = generateInviteCode();
  const doc: InviteDoc = {
    code,
    email: email.toLowerCase(),
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + INVITE_TTL_MS),
    consumed_at: null,
  };
  await c.insertOne(doc);
  return doc;
}

export async function redeemInvite(
  code: string,
  email: string,
): Promise<{ ok: true; invitedBy: ObjectId }> {
  const c = await invitesCollection();
  const row = await c.findOne({ code });
  assertInviteRedeemable(row, email);
  await c.updateOne({ _id: row!._id }, { $set: { consumed_at: new Date().toISOString() } });
  return { ok: true, invitedBy: row!.invited_by };
}

export async function listInvites(): Promise<
  Pick<InviteDoc, 'code' | 'email' | 'expires_at' | 'consumed_at'>[]
> {
  const c = await invitesCollection();
  return c
    .find({}, { projection: { _id: 0, code: 1, email: 1, expires_at: 1, consumed_at: 1 } })
    .toArray();
}

export async function rescindInvite(code: string): Promise<void> {
  const c = await invitesCollection();
  await c.deleteOne({ code });
}
