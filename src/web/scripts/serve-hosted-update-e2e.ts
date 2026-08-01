import { prepareHostedUpdateFixtures } from './production-update-fixtures';

const fixtures = await prepareHostedUpdateFixtures();
process.env.DIST = fixtures.v1;
process.env.MAPLE_E2E_UPDATE_DIST = fixtures.v2;
await import('./serve-dist-coep.mjs');
