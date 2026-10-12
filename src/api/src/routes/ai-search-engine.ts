/**
 * `GET /api/ai/search-engine` — how far the in-process search engine has loaded (#4463). Settings
 * → AI shows it as the child status line; the audit replay (`scripts/search-audit.ts`) waits on it.
 */

import { Elysia } from 'elysia';
import { requireAuth, requireOwnerBeforeHandle } from '../auth/middleware.ts';
import { inProcessSearch, type SearchEngineStatus } from '../search/search-pool.ts';
import { searchModelCacheDir } from '../search/search-child-config.ts';

const NOT_RUNNING: SearchEngineStatus = {
  phase: 'stopped',
  vectors: 0,
  texts: 0,
  textReady: false,
  restarts: 0,
};

export const aiSearchEngineRoutes = new Elysia({ prefix: '/search-engine' }).use(requireAuth).get(
  '/',
  () => ({
    status: inProcessSearch()?.status() ?? NOT_RUNNING,
    modelCacheDir: searchModelCacheDir(),
  }),
  { beforeHandle: requireOwnerBeforeHandle },
);
