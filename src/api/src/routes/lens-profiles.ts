/** Imported calibration is authenticated user content, never a bundled profile catalog. */
import { Elysia, t } from 'elysia';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from '../fs/mirrored.ts';
import { requireFileAccess } from '../auth/middleware.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { loadLensProfile, saveLensProfile } from '../lens-profiles/cache.ts';
import { MAX_LCP_BYTES } from '../lens-profiles/types.ts';

export const lensProfileRoutes = new Elysia({ name: 'lensProfiles', prefix: '/api/lens-profiles' })
  .use(requireFileAccess)
  .post(
    '',
    async ({ body, set }) => {
      if (!ffiPool().available()) {
        set.status = 503;
        return { error: 'The lens-profile engine is unavailable' };
      }
      const file = body.file;
      if (!file.name.toLowerCase().endsWith('.lcp') || !file.size || file.size > MAX_LCP_BYTES) {
        set.status = 400;
        return { error: 'Choose a nonempty .lcp file of at most 32 MiB' };
      }
      const dir = await mkdtemp(join(tmpdir(), 'maple-lcp-import-'));
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = join(dir, 'profile.lcp');
        await writeFile(path, bytes);
        const imported = await ffiPool()
          .registerLensProfile(path)
          .then(
            (inventory) => ({ inventory }),
            (error: unknown) => ({
              error: error instanceof Error ? error.message : 'LCP import failed',
            }),
          );
        if ('error' in imported) {
          set.status = 422;
          return { error: imported.error };
        }
        const inventory = imported.inventory;
        await saveLensProfile(bytes, inventory);
        return inventory;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { body: t.Object({ file: t.File({ maxSize: MAX_LCP_BYTES }) }) },
  )
  .get(
    '/:digest',
    async ({ params, set }) => {
      const bytes = await loadLensProfile(params.digest);
      if (!bytes) {
        set.status = 404;
        return {
          error:
            'The selected lens profile is not stored on this server; import the original profile',
        };
      }
      set.headers['content-type'] = 'application/xml; charset=utf-8';
      set.headers['cache-control'] = 'private, no-store';
      return new Response(new Uint8Array(bytes).buffer, { headers: set.headers as HeadersInit });
    },
    { params: t.Object({ digest: t.String({ pattern: '^[a-f0-9]{64}$' }) }) },
  );
