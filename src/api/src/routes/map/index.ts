/**
 * /api/map — grid-aggregation data feed for the Map view (#2825, epic
 * #2824). Today this is a single endpoint; kept as its own directory
 * (mirroring `routes/search/`) since T2 (`GET /api/map/token`, the
 * MapKit JS token endpoint) is a separate, independently-shipped ticket
 * that will land alongside this one under the same `/api/map` prefix.
 *
 * Internal module layout:
 *   - `clusters.ts` — `GET /clusters`
 */

import { Elysia } from 'elysia';
import { mapClustersRoute } from './clusters.ts';

export { MapClustersQueryT, type MapClustersQuery, type MapCluster } from './clusters.ts';

export const mapRoutes = new Elysia({ prefix: '/api/map' }).use(mapClustersRoute);
