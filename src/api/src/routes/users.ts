// src/api/src/routes/users.ts
//
// Owner-only user roster + per-user permission editing (#2893).
//
//   GET   /api/users      — every account (id, email, role, permissions)
//   PATCH /api/users/:id  — set a member's `file_access` permission
//
// Before this file there was deliberately NO roster endpoint (the Users
// settings page only listed invites); the file-access permission is the
// first per-user attribute an operator can edit, so the roster ships with
// it. A permission change lands in newly-minted access tokens only — an
// in-flight token keeps its old claim until it expires (≤15 min), the same
// stateless trade `role` makes (see auth/middleware.ts).

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { usersCollection } from '../db/client.ts';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import { userFileAccess } from '../auth/permissions.ts';
import type { UserDoc } from '../db/schema.ts';
import type { WithId } from 'mongodb';

function toPublicUser(u: WithId<UserDoc>) {
  return {
    id: u._id.toHexString(),
    email: u.email,
    role: u.role,
    file_access: userFileAccess(u),
    created_at: u.created_at,
    last_seen_at: u.last_seen_at,
  };
}

export const usersRoutes = new Elysia({ prefix: '/api/users' })
  // Both mounted directly (same as cloudflare.ts): requireAuth's scoped
  // derive only promotes one level, so nesting it solely inside requireOwner
  // would leave `auth` undefined in this instance's handlers.
  .use(requireAuth)
  .use(requireOwner)
  .get('/', async () => {
    const coll = await usersCollection();
    const docs = await coll.find({}).sort({ created_at: 1 }).toArray();
    return docs.map(toPublicUser);
  })
  .patch(
    '/:id',
    async ({ params, body, set }) => {
      if (!ObjectId.isValid(params.id)) {
        set.status = 400;
        return { error: 'invalid user id' };
      }
      const coll = await usersCollection();
      const user = await coll.findOne({ _id: new ObjectId(params.id) });
      if (!user) {
        set.status = 404;
        return { error: 'user not found' };
      }
      if (user.role === 'owner') {
        set.status = 400;
        return { error: 'the owner always has file access' };
      }
      await coll.updateOne({ _id: user._id }, { $set: { file_access: body.file_access } });
      return toPublicUser({ ...user, file_access: body.file_access });
    },
    { body: t.Object({ file_access: t.Boolean() }) },
  );
