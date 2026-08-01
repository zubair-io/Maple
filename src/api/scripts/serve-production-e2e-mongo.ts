import { rename, writeFile } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';

const uriFile = process.env.MAPLE_E2E_MONGO_URI_FILE;
if (!uriFile) throw new Error('MAPLE_E2E_MONGO_URI_FILE is required');

const server = await MongoMemoryServer.create({
  instance: { dbName: 'maple_e2e' },
});
const pendingUriFile = `${uriFile}.tmp-${process.pid}`;
await writeFile(pendingUriFile, server.getUri('maple_e2e'));
await rename(pendingUriFile, uriFile);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
await new Promise(() => undefined);
