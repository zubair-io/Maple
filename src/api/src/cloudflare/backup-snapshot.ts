import { createHash } from 'node:crypto';

export interface SnapshotInfo {
  schema: string;
  bytes: number;
  compressed_bytes: number;
  sha256: string;
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest('hex');
}

export function createSnapshot(source: string, target: string): Promise<SnapshotInfo> {
  return runSnapshotWorker(source, target);
}

export function inspectSnapshot(target: string): Promise<SnapshotInfo> {
  return runSnapshotWorker(null, target);
}

function runSnapshotWorker(source: string | null, target: string): Promise<SnapshotInfo> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-snapshot.worker.ts', import.meta.url).href);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('Database snapshot timed out'));
    }, 60 * 60_000);
    worker.onmessage = (event: MessageEvent<{ result?: SnapshotInfo; error?: string }>) => {
      finish();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? 'Snapshot worker failed'));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    worker.postMessage({ source, target });
  });
}
