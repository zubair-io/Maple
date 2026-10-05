import { fileURLToPath } from 'node:url';

export async function inOtherProcess(databasePath: string, body: string, args: string[] = []) {
  const lifecycle = fileURLToPath(new URL('./lifecycle.ts', import.meta.url));
  const repository = fileURLToPath(new URL('./repository.ts', import.meta.url));
  const helpers = fileURLToPath(
    new URL('../db/sqlite/test-sqlite.test-helpers.ts', import.meta.url),
  );
  const mirrored = fileURLToPath(new URL('../fs/mirrored.ts', import.meta.url));
  const script = `import { Database } from 'bun:sqlite';
    import * as lifecycle from ${JSON.stringify(lifecycle)};
    import { BackupRepository } from ${JSON.stringify(repository)};
    import { testSqliteDb } from ${JSON.stringify(helpers)};
    import * as fs from ${JSON.stringify(mirrored)};
    const [databasePath, ...args] = process.argv.slice(1);
    const db = new Database(databasePath);
    db.exec('PRAGMA busy_timeout=5000');
    const repo = new BackupRepository(testSqliteDb(db));
    try { ${body} } finally { db.close(); }`;
  const child = Bun.spawn([process.execPath, '--no-install', '-e', script, databasePath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Lifecycle child failed: ${stderr}`);
  return stdout;
}

export const reconcileInChild = (databasePath: string) =>
  inOtherProcess(databasePath, 'await lifecycle.reconcileLifecycle(repo);');
