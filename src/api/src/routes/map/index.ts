/**
 * /api/map — grid-aggregation data feed for the Map view (#2825, epic
 * #2824). Today this is a single endpoint; kept as its own directory
 * (mirroring `routes/search/`) because sibling epic tickets add further
 * endpoints under the same `/api/map` prefix.
 *
 * The endpoint here is deliberately map-engine-agnostic: it returns
 * plain lat/lng cells, so it feeds the Apple-native MapKit view and the
 * web client identically regardless of which tile/SDK the web front-end
 * settles on.
 *
 * Internal module layout:
 *   - `clusters.ts` — `GET /clusters`
 */

import { Elysia } from 'elysia';
import { mapClustersRoute } from './clusters.ts';

export const mapRoutes = new Elysia({ prefix: '/api/map' }).use(mapClustersRoute);
