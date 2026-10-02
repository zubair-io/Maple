/** Authorized selected-variant storage (#4040 / #2437). */
import { Elysia, status, t } from 'elysia';
import { resolveAndAuthorizePath } from './xmp-path-auth';
import { parseSidecarWorkflow, PRIMARY_VARIANT_ID } from '../generated/workflow.generated';
import {
  createWorkflowVariant,
  listWorkflowVariants,
  readWorkflowVariant,
  writeWorkflowVariant,
  WorkflowVariantError,
} from '../fs/workflow-variants';

export const xmpVariantRoutes = new Elysia()
  .onError(({ error }) => {
    if (error instanceof WorkflowVariantError)
      return status(error.status, { error: error.message });
  })
  .resolve(async ({ query }) => {
    const authorized = await resolveAndAuthorizePath(query.path);
    if (!authorized.ok) return status(authorized.status, { error: authorized.error });
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
    async ({ rawPath, query, body, set }) => {
      const xml = await writeWorkflowVariant(rawPath, query.variantId, body);
      set.headers['Content-Type'] = 'application/xml';
      return xml;
    },
    {
      query: t.Object({ path: t.String(), variantId: t.String() }),
      body: t.String(),
      parse: 'text',
      detail: { tags: ['xmp'], summary: 'Atomically save one selected variant' },
    },
  );
