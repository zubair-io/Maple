import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest('hex');
}

async function gzipFile(source: string, target: string): Promise<void> {
  const file = await open(target, 'w', 0o600);
  try {
    const gzip = Bun.file(source).stream().pipeThrough(new CompressionStream('gzip'));
    for await (const chunk of gzip) await file.write(chunk);
  } finally {
    await file.close();
  }
}

declare const self: Worker;
self.onmessage = async (event: MessageEvent<{ source: string | null; target: string }>) => {
  try {
    const { source, target } = event.data;
    // A private connection keeps VACUUM off the pool's serial writer queue.
    if (source) {
      const db = new Database(source, { readonly: true });
      try {
        db.run('PRAGMA busy_timeout = 5000');
        db.query('VACUUM INTO ?').run(target);
      } finally {
        db.close();
      }
    }
    const snapshot = new Database(target, { readonly: true });
    const schema = (() => {
      try {
        const check = snapshot.query('PRAGMA integrity_check').get() as { integrity_check: string };
        if (check.integrity_check !== 'ok') throw new Error('Snapshot integrity check failed');
        const row = snapshot.query('SELECT max(id) AS id FROM schema_migrations').get() as {
          id: string | null;
        };
        if (!row.id) throw new Error('Snapshot has no Maple schema');
        return row.id;
      } finally {
        snapshot.close();
      }
    })();
    const sha256 = await fileSha256(target);
    if (source) await gzipFile(target, `${target}.gz`);
    self.postMessage({
      result: {
        schema,
        sha256,
        bytes: Bun.file(target).size,
        compressed_bytes: source ? Bun.file(`${target}.gz`).size : 0,
      },
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
