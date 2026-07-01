import type { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { invitesCollection } from '../db/client.ts';
import type { InviteDoc } from '../db/schema.ts';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 (no 0/1/8/9)
const TTL_MS = 15 * 60 * 1000;

function genCode(): string {
  const b = randomBytes(8);
  return Array.from(b, (x) => ALPHA[x % 32]).join('');
}

export async function createInvite(
  invitedBy: ObjectId,
  email: string,
): Promise<InviteDoc & { code: string; expires_at: Date }> {
  const c = await invitesCollection();
  const code = genCode();
  const doc: InviteDoc = {
    code,
    email: email.toLowerCase(),
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + TTL_MS),
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
  if (!row) throw Object.assign(new Error('invite not found'), { status: 410 });
  if (row.email !== email.toLowerCase())
    throw Object.assign(new Error('invite/email mismatch'), { status: 410 });
  if (row.consumed_at !== null) throw Object.assign(new Error('invite consumed'), { status: 410 });
  if (row.expires_at.getTime() < Date.now())
    throw Object.assign(new Error('invite expired'), { status: 410 });
  await c.updateOne({ _id: row._id }, { $set: { consumed_at: new Date().toISOString() } });
  return { ok: true, invitedBy: row.invited_by };
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
