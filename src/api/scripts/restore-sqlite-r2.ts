import { resolve } from 'node:path';
import { BackupR2 } from '../src/cloudflare/backup-r2.ts';
import { restoreBackup } from '../src/cloudflare/backup-restore.ts';
import { sqliteDatabasePath } from '../src/db/sqlite/database-path.ts';
import type { ResolvedCloudflareConfig } from '../src/cloudflare/r2-client.ts';

const [credentialsPath, key, destination] = process.argv.slice(2);
if (!credentialsPath || !key) {
  console.error(
    'Usage: bun scripts/restore-sqlite-r2.ts /secure/r2.json <backup-key | --list> [target.db]\nStop Maple before restoring. Existing targets and WAL/SHM files are never overwritten.',
  );
  process.exit(1);
}
try {
  const value: unknown = await Bun.file(credentialsPath).json();
  if (
    !value ||
    typeof value !== 'object' ||
    !['account_id', 'bucket', 'access_key_id', 'secret_access_key'].every(
      (field) =>
        typeof Reflect.get(value, field) === 'string' && Reflect.get(value, field).length > 0,
    )
  )
    throw new Error('Invalid R2 credentials file');
  const storage = new BackupR2(value as ResolvedCloudflareConfig);
  if (key === '--list') console.log((await storage.list()).sort().reverse().join('\n'));
  else {
    const target = resolve(destination ?? sqliteDatabasePath());
    await restoreBackup(await storage.download(key), target);
    console.log(`Verified database restored to ${target}. Start Maple using this database path.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
