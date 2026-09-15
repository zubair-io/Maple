/** Read-only: bypass getDb(), whose initialization can perform migrations. */
import { MongoClient } from 'mongodb';
import { auditMapleIds } from '../src/audits/maple-ids.ts';

if (!process.env.MAPLE_MONGO_URI || !process.env.MAPLE_MONGO_DB) {
  throw new Error(
    'Set the existing MAPLE_MONGO_URI and MAPLE_MONGO_DB explicitly; use read-only credentials.',
  );
}
const client = new MongoClient(process.env.MAPLE_MONGO_URI, { appName: 'maple-id-audit-3642' });
try {
  await client.connect();
  console.log(
    JSON.stringify({
      type: 'start',
      version: 1,
      database: process.env.MAPLE_MONGO_DB,
      startedAt: new Date().toISOString(),
    }),
  );
  const summary = await auditMapleIds(client.db(process.env.MAPLE_MONGO_DB), (finding) => {
    console.log(JSON.stringify(finding));
  });
  console.log(
    JSON.stringify({ type: 'complete', ...summary, finishedAt: new Date().toISOString() }),
  );
} finally {
  await client.close();
}
