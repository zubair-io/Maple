import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { requireAuth, requireOwner, stepUpBeforeHandle } from '../auth/middleware.ts';
import {
  createServiceApiKey,
  listServiceApiKeys,
  revokeServiceApiKey,
} from '../auth/service-api-keys.ts';

const CreateBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 200 }),
  scopes: t.Optional(t.Array(t.Literal('assets:search'), { minItems: 1, maxItems: 1 })),
  expiresAt: t.Optional(t.Union([t.String({ format: 'date-time' }), t.Null()])),
});

export const serviceApiKeyAdminRoutes = new Elysia({
  name: 'serviceApiKeyAdminRoutes',
  prefix: '/api/admin/service-api-keys',
})
  .use(requireAuth)
  .use(requireOwner)
  .get('/', async () => ({ keys: await listServiceApiKeys() }))
  .post(
    '/',
    async ({ auth, body, set }) => {
      if (!ObjectId.isValid(auth.user.sub)) {
        set.status = 400;
        return { error: 'owner subject is not a valid user id' };
      }
      const createdBy = new ObjectId(auth.user.sub);
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
        set.status = 400;
        return { error: 'expiresAt must be in the future' };
      }
      const created = await createServiceApiKey({
        name: body.name,
        scopes: body.scopes,
        createdBy,
        expiresAt,
      });
      set.status = 201;
      return created;
    },
    { body: CreateBody, beforeHandle: stepUpBeforeHandle },
  )
  .delete(
    '/:keyId',
    async ({ params, set }) => {
      const revoked = await revokeServiceApiKey(params.keyId);
      if (!revoked) {
        set.status = 404;
        return { error: 'service API key not found or already revoked' };
      }
      set.status = 204;
      return;
    },
    { beforeHandle: stepUpBeforeHandle },
  );
