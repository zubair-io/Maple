import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest('hex');
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
    if (source)
      await Bun.write(
        `${target}.gz`,
        new Response(Bun.file(target).stream().pipeThrough(new CompressionStream('gzip'))),
      );
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
