/**
 * /api/presets — user develop presets (#1115, spec §10.7).
 *
 *   GET    /api/presets      — list user presets (name-sorted)
 *   POST   /api/presets      — body { schemaVersion, name, fields, …extra }
 *                              → 201 created row; 409 on duplicate name
 *   DELETE /api/presets/:id  — delete one preset
 *
 * A preset is a named, schema-versioned SPARSE AdjustmentModel — see
 * `PresetDoc` in `db/schema.ts` for the document contract and
 * `presets/preset-validation.ts` for the field rules. Built-in presets are
 * NOT served here; they ship as bundled JSON inside each client.
 *
 * Presets are user DATA (not config) — they live in their own collection,
 * not `worker_config`. Like the other data collections (people, folders),
 * rows are library-wide: the server hosts one household library, so there
 * is no per-user scoping on any data route today. Mounted behind
 * `requireAuth` in `src/api/src/index.ts` like every data route.
 */

import { Elysia, t } from 'elysia';
import {
  deletePreset,
  insertPreset,
  isPresetNameConflict,
  listPresets,
} from '../db/sqlite/repos/presets.repo.ts';
import type { PresetDoc, PresetWithId } from '../db/schema.ts';
import {
  isStorableKey,
  unstorableKeyError,
  validatePresetDocument,
} from '../presets/preset-validation.ts';
import { child as childLogger } from '../log.ts';
import { safeObjectId } from '../db/safe-object-id.ts';

const log = childLogger('presets:routes');

const CreateBody = t.Object(
  {
    schemaVersion: t.Number(),
    name: t.String({ minLength: 1 }),
    fields: t.Record(t.String(), t.Unknown()),
  },
  // Unknown top-level keys from newer schema versions must reach the
  // handler so they can be preserved (the passthrough rule) — don't let
  // the validator strip or reject them.
  { additionalProperties: true },
);

/** Top-level payload keys owned by this schema version. Anything else in
 * the create body is preserved verbatim in `doc.extra` and spread back
 * onto the wire row on read. */
const OWNED_KEYS = new Set(['schemaVersion', 'name', 'fields']);

/** Depth-first scan of a preserved value for a key the store will not take.
 * `extra` persists as JSON in a text column, so a NUL byte inside a key is a
 * real hazard; `.` and a leading `$` are inherited from the document-key era
 * and stay rejected because the accepted input set is part of the API
 * contract, not because storage needs it. Returns the first offending key, or
 * null when the whole value is safe. See `presets/preset-validation.ts`. */
function findUnstorableKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const bad = findUnstorableKey(item);
      if (bad !== null) return bad;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (!isStorableKey(key)) return key;
      const bad = findUnstorableKey(nested);
      if (bad !== null) return bad;
    }
  }
  return null;
}

/** Wire shape: unknown preserved keys first so the owned keys win. */
function toWireRow(row: PresetWithId) {
  return {
    ...(row.extra ?? {}),
    id: row._id.toHexString(),
    schemaVersion: row.schema_version,
    name: row.name,
    fields: row.fields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const presetsRoutes = new Elysia({ prefix: '/api/presets' })
  // ── List ────────────────────────────────────────────────────────────
  .get('/', async () => {
    const rows = await listPresets();
    return { presets: rows.map(toWireRow) };
  })

  // ── Create ──────────────────────────────────────────────────────────
  .post(
    '/',
    async ({ body, set }) => {
      const validated = validatePresetDocument(body);
      if (!validated.ok) {
        set.status = 400;
        return { error: validated.error };
      }
      const { name, schemaVersion, fields } = validated.preset;

      // Preserve unknown top-level keys (newer-version documents) — but
      // only Mongo-safe ones. The preserved keys (and any keys nested in
      // their values) become `doc.extra` subdocument keys; an unsafe key
      // would blow up the insert as a 500, so reject it as a 400 here,
      // matching the `fields` validation.
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (OWNED_KEYS.has(key)) continue;
        const bad = isStorableKey(key) ? findUnstorableKey(value) : key;
        if (bad !== null) {
          set.status = 400;
          return { error: unstorableKeyError(bad) };
        }
        extra[key] = value;
      }

      const now = new Date().toISOString();
      const doc: PresetDoc = {
        name,
        schema_version: schemaVersion,
        fields,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
        created_at: now,
        updated_at: now,
      };

      try {
        const insertedId = await insertPreset(doc);
        set.status = 201;
        return toWireRow({ _id: insertedId, ...doc });
      } catch (err) {
        // The case-insensitive unique name index rejected it.
        if (isPresetNameConflict(err)) {
          set.status = 409;
          return { error: `a preset named "${name}" already exists` };
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'preset insert failed');
        set.status = 500;
        return { error: msg };
      }
    },
    { body: CreateBody },
  )

  // ── Delete ──────────────────────────────────────────────────────────
  .delete('/:id', async ({ params, set }) => {
    const id = safeObjectId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'invalid preset id' };
    }
    const res = await deletePreset(id);
    if (res.deletedCount === 0) {
      set.status = 404;
      return { error: 'preset not found' };
    }
    return { ok: true };
  });
