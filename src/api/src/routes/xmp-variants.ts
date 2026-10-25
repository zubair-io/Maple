/** Authorized selected-variant storage (#4040 / #2437). */
import { Elysia, status, t } from 'elysia';
import { SidecarWritePathDeniedError } from '../fs/sidecar-write-order';
import { publishSidecarChange } from './xmp-change';
import { authorizeXmpRequest } from './xmp-path-auth';
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

function publishVariantMutation<T extends unknown[]>(
  rawPath: string,
  variantId: string,
  mutation: (rawPath: string, variantId: string, ...args: T) => Promise<string>,
  ...args: T
): Promise<Response> {
  return mutation(rawPath, variantId, ...args).then((xml) =>
    publishedVariant(rawPath, variantId, xml),
  );
}

const variantQuery = t.Object({ path: t.String(), variantId: t.String() });

export const xmpVariantRoutes = new Elysia()
  .onError(({ error }) => {
    if (error instanceof SidecarWritePathDeniedError) return status(409, { error: error.message });
    if (error instanceof WorkflowVariantError)
      return status(error.status, { error: error.message });
  })
  .resolve(async ({ query, request }) => {
    const authorized = await authorizeXmpRequest(query.path, request.method);
    if (!authorized.ok) throw new WorkflowVariantError(authorized.status, authorized.error);
    return { rawPath: authorized.data, writeScope: authorized.writeScope };
  })
  .get(
    '/api/xmp/variants',
    ({ rawPath, request }) => listWorkflowVariants(rawPath, request.signal),
    {
      query: t.Object({ path: t.String() }),
      detail: { tags: ['xmp'], summary: 'Discover portable sibling variants' },
    },
  )
  .get(
    '/api/xmp/variant',
    async ({ rawPath, query, set, request }) => {
      const xml = await readWorkflowVariant(rawPath, query.variantId, request.signal);
      if (xml === null) return status(404, { error: 'No primary XMP sidecar at this path' });
      set.headers['Content-Type'] = 'application/xml';
      return xml;
    },
    {
      query: variantQuery,
      detail: { tags: ['xmp'], summary: 'Read one exact variant identity' },
    },
  )
  .post(
    '/api/xmp/variants',
    async ({ rawPath, writeScope, query, body, set, request }) => {
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
        request.signal,
        writeScope,
      );
      set.status = 201;
      return variant;
    },
    {
      query: t.Object({
        path: t.String(),
        sourceVariantId: t.Optional(t.String()),
      }),
      body: t.Any(),
      detail: {
        tags: ['xmp'],
        summary: 'Create an independent sibling from committed source edits',
      },
    },
  )
  .put(
    '/api/xmp/variant',
    async ({ rawPath, writeScope, query, body, request }) => {
      const xml = await writeWorkflowVariant(
        rawPath,
        query.variantId,
        body,
        request.signal,
        writeScope,
      );
      return publishedVariant(rawPath, query.variantId, xml);
    },
    {
      query: variantQuery,
      body: t.String(),
      parse: 'text',
      detail: {
        tags: ['xmp'],
        summary: 'Atomically save one selected variant',
      },
    },
  )
  .post(
    '/api/xmp/variant/commit',
    ({ rawPath, writeScope, query, body, request }) =>
      publishVariantMutation(
        rawPath,
        query.variantId,
        commitWorkflowVariant,
        body.expectedXmp,
        body.xmp,
        body.entry,
        request.signal,
        writeScope,
      ),
    {
      query: variantQuery,
      body: t.Object({
        expectedXmp: t.Union([t.String(), t.Null()]),
        xmp: t.String(),
        entry: t.Any(),
      }),
      detail: {
        tags: ['xmp'],
        summary: 'Confirm a selected variant semantic adjustment commit',
      },
    },
  )
  .post(
    '/api/xmp/variant/snapshot',
    ({ rawPath, writeScope, query, body, request }) =>
      publishVariantMutation(
        rawPath,
        query.variantId,
        snapshotWorkflowVariant,
        body.expectedXmp,
        body.snapshot,
        body.initialXmp,
        request.signal,
        writeScope,
      ),
    {
      query: variantQuery,
      body: t.Object({
        expectedXmp: t.Union([t.String(), t.Null()]),
        snapshot: t.Object({
          id: t.String({ pattern: `^${WORKFLOW_UUID_PATTERN}$` }),
          name: t.String({
            minLength: 1,
            maxLength: WORKFLOW_MAX_BYTES,
            pattern: '\\S',
          }),
          createdAtMs: t.Integer({
            minimum: 0,
            maximum: WORKFLOW_MAX_TIMESTAMP_MS,
          }),
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
    ({ rawPath, writeScope, query, body, request }) =>
      publishVariantMutation(
        rawPath,
        query.variantId,
        restoreWorkflowVariant,
        body.expectedXmp,
        body.entry,
        request.signal,
        writeScope,
      ),
    {
      query: variantQuery,
      body: t.Object({ expectedXmp: t.String(), entry: t.Any() }),
      detail: {
        tags: ['xmp'],
        summary: 'Confirm a recorded snapshot or history restore',
      },
    },
  );
