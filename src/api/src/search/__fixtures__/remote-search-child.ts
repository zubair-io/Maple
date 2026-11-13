/**
 * A worker-tier stand-in for `remote-search.test.ts`: installs the bridge the way `worker-main.ts`
 * does, ranks once through it, and reports what came back over the same IPC channel.
 */

import { installRemoteInProcessSearch } from '../remote-search.ts';
import { inProcessRanker } from '../search-pool.ts';

installRemoteInProcessSearch();
const hits = (await inProcessRanker()?.search('harbour', 7)) ?? null;
process.send?.({ type: 'fixture-result', hits });
