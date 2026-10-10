/**
 * `/api/ai/search-engine` — the engine that ranks text searches (#4463), and how far the
 * in-process one has loaded. Settings → AI reads and writes it; so does the audit replay
 * (`scripts/search-audit.ts`), which toggles it to compare the two engines.
 */

import { Elysia, t } from 'elysia';
import { requireAuth, requireOwnerBeforeHandle } from '../auth/middleware.ts';
import {
  applySearchEngine,
  saveSearchEngine,
  selectedSearchEngine,
  SEARCH_ENGINES,
} from '../search/search-engine-selection.ts';
import { inProcessSearch, type SearchEngineStatus } from '../search/search-pool.ts';

const NOT_RUNNING: SearchEngineStatus = {
  phase: 'stopped',
  vectors: 0,
  texts: 0,
  textReady: false,
  restarts: 0,
};

async function searchEngineView() {
  return {
    engine: await selectedSearchEngine(),
    status: inProcessSearch()?.status() ?? NOT_RUNNING,
  };
}

export const aiSearchEngineRoutes = new Elysia({ prefix: '/search-engine' })
  .use(requireAuth)
  .get('/', searchEngineView, { beforeHandle: requireOwnerBeforeHandle })
  .put(
    '/',
    async ({ body }) => {
      await saveSearchEngine(body.engine);
      applySearchEngine(body.engine);
      return searchEngineView();
    },
    {
      body: t.Object({ engine: t.Union(SEARCH_ENGINES.map((engine) => t.Literal(engine))) }),
      beforeHandle: requireOwnerBeforeHandle,
    },
  );
