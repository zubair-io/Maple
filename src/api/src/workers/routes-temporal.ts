import { Elysia, t } from 'elysia';
import { requireOwnerBeforeHandle } from '../auth/middleware.ts';
import {
  readTemporalStatus,
  saveTemporalSettings,
  TemporalSettingsError,
} from '../temporal/temporal-config.ts';

/**
 * The worker tier re-reads these on its own; saving them needs no IPC and no
 * restart. Saving is the owner's: whoever names the Temporal server decides
 * whether any job runs, and can cancel the ones that are running.
 */
export const temporalRoutes = new Elysia({ prefix: '/temporal' })
  .get('', () => readTemporalStatus())
  .put(
    '',
    async ({ body, set }) => {
      try {
        await saveTemporalSettings(body);
      } catch (error) {
        if (!(error instanceof TemporalSettingsError)) throw error;
        set.status = 400;
        return { error: error.message };
      }
      return readTemporalStatus();
    },
    {
      beforeHandle: requireOwnerBeforeHandle,
      body: t.Object({
        address: t.String({ minLength: 1, maxLength: 255 }),
        namespace: t.String({ minLength: 1, maxLength: 255 }),
      }),
    },
  );
