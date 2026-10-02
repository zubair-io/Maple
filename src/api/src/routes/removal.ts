/** #3984: authenticated Self Hosted companion transfer and confirmed XMP. */
import { Elysia, t } from 'elysia';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { publishSidecarChange } from './xmp-change';
import {
  RemovalAuthoringError,
  removalSidecarSnapshot,
  commitRemovalSidecar,
  publishRemovalCompanion,
  readRemovalCompanion,
} from '../fs/removal-authoring.ts';

const pathQuery = t.Object({ path: t.String() });
const assetQuery = t.Object({ path: t.String(), name: t.String() });

async function authorized<T>(path: string, work: (raw: string) => Promise<T>) {
  // Elysia has decoded the query once. The legacy authorization helper accepts
  // an encoded path and decodes it itself; preserve literal percent filenames.
  const resolved = await resolveAndAuthorizePath(encodeURIComponent(path));
  if (!resolved.ok) throw new RemovalAuthoringError(resolved.status, resolved.error);
  return work(resolved.data);
}

// Authentication is inherited from authedApi, like the path-keyed XMP routes.
export const removalRoutes = new Elysia({ name: 'removalRoutes', prefix: '/api/removal' })
  .onError(({ error, set }) => {
    if (error instanceof RemovalAuthoringError) {
      set.status = error.status;
      return { error: error.message };
    }
  })
  .get(
    '/xmp',
    ({ query, set }) => {
      set.headers['Cache-Control'] = 'private, no-store';
      return authorized(query.path, removalSidecarSnapshot);
    },
    { query: pathQuery },
  )
  .post(
    '/xmp',
    async ({ query, body, set }) => {
      const result = await authorized(query.path, async (raw) => {
        const saved = await commitRemovalSidecar(raw, body);
        // The bytes are already durable. Feed failure is best-effort, just like
        // ordinary XMP saves; it must not report a successful commit as failed.
        await publishSidecarChange(raw, true);
        return saved;
      });
      set.headers['Cache-Control'] = 'private, no-store';
      return result;
    },
    {
      query: pathQuery,
      body: t.Object({
        expectedRevision: t.String({ pattern: '^(missing|[a-f0-9]{64})$' }),
        expectedRecords: t.String(),
        xml: t.String(),
      }),
    },
  )
  .get(
    '/companion',
    async ({ query, set }) => {
      const bytes = await authorized(query.path, (raw) => readRemovalCompanion(raw, query.name));
      set.headers['Content-Type'] = 'application/octet-stream';
      set.headers['Cache-Control'] = 'private, no-store';
      return new Response(bytes, { headers: set.headers as Record<string, string> });
    },
    { query: assetQuery },
  )
  .put(
    '/companion',
    ({ query, body }) =>
      authorized(query.path, (raw) =>
        publishRemovalCompanion(raw, query.name, new Uint8Array(body)),
      ),
    { query: assetQuery, parse: 'arrayBuffer', body: t.ArrayBuffer() },
  );
