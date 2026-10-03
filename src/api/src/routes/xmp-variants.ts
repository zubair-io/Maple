/** Authorized selected-variant storage (#4040 / #2437). */
import { Elysia, status, t } from 'elysia';
import { publishSidecarChange } from './xmp-change';
import { resolveAndAuthorizePath } from './xmp-path-auth';
import {
  parseSidecarWorkflow,
  PRIMARY_VARIANT_ID,
  WORKFLOW_MAX_BYTES,
  WORKFLOW_MAX_TIMESTAMP_MS,
  WORKFLOW_UUID_PATTERN,
} from '../generated/workflow.generated';
import {
  createWorkflowVariant,
  commitWorkflowVariant,
  snapshotWorkflowVariant,
  restoreWorkflowVariant,
  listWorkflowVariants,
  readWorkflowVariant,
  writeWorkflowVariant,
  WorkflowVariantError,
} from '../fs/workflow-variants';

async function publishedVariant(
  rawPath: string,
  variantId: string,
  xml: string,
): Promise<Response> {
  if (variantId === PRIMARY_VARIANT_ID) await publishSidecarChange(rawPath, true);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
}

export const xmpVariantRoutes = new Elysia()
  .onError(({ error }) => {
    if (error instanceof WorkflowVariantError)
      return status(error.status, { error: error.message });
  })
  .resolve(async ({ query }) => {
    const authorized = await resolveAndAuthorizePath(query.path);
    if (!authorized.ok) throw new WorkflowVariantError(authorized.status, authorized.error);
    return { rawPath: authorized.data };
  })
  .get('/api/xmp/variants', ({ rawPath }) => listWorkflowVariants(rawPath), {
    query: t.Object({ path: t.String() }),
    detail: { tags: ['xmp'], summary: 'Discover portable sibling variants' },
  })
  .get(
    '/api/xmp/variant',
    async ({ rawPath, query, set }) => {
      const xml = await readWorkflowVariant(rawPath, query.variantId);
      if (xml === null) return status(404, { error: 'No primary XMP sidecar at this path' });
      set.headers['Content-Type'] = 'application/xml';
      return xml;
    },
    {
      query: t.Object({ path: t.String(), variantId: t.String() }),
      detail: { tags: ['xmp'], summary: 'Read one exact variant identity' },
    },
  )
  .post(
    '/api/xmp/variants',
    async ({ rawPath, query, body, set }) => {
      const workflow = (() => {
        try {
          return parseSidecarWorkflow(body);
        } catch (error) {
          throw new WorkflowVariantError(
            422,
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
      const variant = await createWorkflowVariant(
        rawPath,
        workflow,
        query.sourceVariantId ?? PRIMARY_VARIANT_ID,
      );
      set.status = 201;
      return variant;
    },
    {
      query: t.Object({ path: t.String(), sourceVariantId: t.Optional(t.String()) }),
      body: t.Any(),
      detail: {
        tags: ['xmp'],
        summary: 'Create an independent sibling from committed source edits',
      },
    },
  )
  .put(
    '/api/xmp/variant',
    async ({ rawPath, query, body }) => {
      const xml = await writeWorkflowVariant(rawPath, query.variantId, body);
      return publishedVariant(rawPath, query.variantId, xml);
    },
    {
      query: t.Object({ path: t.String(), variantId: t.String() }),
      body: t.String(),
      parse: 'text',
      detail: { tags: ['xmp'], summary: 'Atomically save one selected variant' },
    },
  )
  .post(
    '/api/xmp/variant/commit',
    async ({ rawPath, query, body }) => {
      const output = await commitWorkflowVariant(
        rawPath,
        query.variantId,
        body.expectedXmp,
        body.xmp,
        body.entry,
      );
      return publishedVariant(rawPath, query.variantId, output);
    },
    {
      query: t.Object({ path: t.String(), variantId: t.String() }),
      body: t.Object({
        expectedXmp: t.Union([t.String(), t.Null()]),
        xmp: t.String(),
        entry: t.Any(),
      }),
      detail: { tags: ['xmp'], summary: 'Confirm a selected variant semantic adjustment commit' },
    },
  )
  .post(
    '/api/xmp/variant/snapshot',
    async ({ rawPath, query, body }) => {
      const output = await snapshotWorkflowVariant(
        rawPath,
        query.variantId,
        body.expectedXmp,
        body.snapshot,
        body.initialXmp,
      );
      return publishedVariant(rawPath, query.variantId, output);
    },
    {
      query: t.Object({ path: t.String(), variantId: t.String() }),
      body: t.Object({
        expectedXmp: t.Union([t.String(), t.Null()]),
        snapshot: t.Object({
          id: t.String({ pattern: `^${WORKFLOW_UUID_PATTERN}$` }),
          name: t.String({ minLength: 1, maxLength: WORKFLOW_MAX_BYTES, pattern: '\\S' }),
          createdAtMs: t.Integer({ minimum: 0, maximum: WORKFLOW_MAX_TIMESTAMP_MS }),
          adjustmentXmp: t.String({ maxLength: WORKFLOW_MAX_BYTES }),
        }),
        initialXmp: t.Optional(t.String()),
      }),
      detail: {
        tags: ['xmp'],
        summary: 'Confirm an immutable named snapshot in the selected variant',
      },
    },
  )
  .post(
    '/api/xmp/variant/restore',
    async ({ rawPath, query, body }) => {
      const output = await restoreWorkflowVariant(
        rawPath,
        query.variantId,
        body.expectedXmp,
        body.entry,
      );
      return publishedVariant(rawPath, query.variantId, output);
    },
    {
      query: t.Object({ path: t.String(), variantId: t.String() }),
      body: t.Object({ expectedXmp: t.String(), entry: t.Any() }),
      detail: { tags: ['xmp'], summary: 'Confirm a recorded snapshot or history restore' },
    },
  );
