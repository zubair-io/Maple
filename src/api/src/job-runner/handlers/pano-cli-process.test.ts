/**
 * The maple-cli subprocess lifecycle: a lost job lease or a CLI that ignores
 * SIGTERM must still leave no process running, and the decode memory budget
 * is handed back only once the process has exited.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from '../../fs/mirrored.ts';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { decodeMemoryBudget } from '../../ffi/decode-memory-budget.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { JobHandlerContext } from './index.ts';
import { runPanoCli, terminateCli } from './pano-cli-process.ts';
import { parsePayload } from './pano-stitch.ts';

let live: LiveTestDatabase;
let tmpDir = '';

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-cli-process-')));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  invalidateLibraryRoots();
});

afterEach(() => {
  live.close();
  decodeMemoryBudget().configure(null);
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function spawnIgnoringSigterm(): Bun.Subprocess {
  return Bun.spawn(
    [process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdout: 'ignore', stderr: 'ignore' },
  );
}

describe('terminateCli', () => {
  it('escalates to SIGKILL when the CLI ignores SIGTERM', async () => {
    const proc = spawnIgnoringSigterm();
    await Bun.sleep(200);
    await terminateCli(proc, 100);
    expect(proc.signalCode).toBe('SIGKILL');
    expect(alive(proc.pid)).toBe(false);
  });

  it('stops a CLI that honours SIGTERM without escalating', async () => {
    const proc = Bun.spawn(['sleep', '30']);
    await terminateCli(proc, 5_000);
    expect(proc.signalCode).toBe('SIGTERM');
  });

  it('leaves an exited CLI alone', async () => {
    const proc = Bun.spawn(['true']);
    await proc.exited;
    await terminateCli(proc, 100);
    expect(proc.exitCode).toBe(0);
  });
});

describe('runPanoCli on a lost job lease', () => {
  it('kills the CLI before it gives the memory budget back', async () => {
    const pidFile = path.join(tmpDir, 'cli.pid');
    const cli = path.join(tmpDir, 'long-running-cli');
    await fs.writeFile(cli, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
    await fs.chmod(cli, 0o755);
    const budget = decodeMemoryBudget();
    budget.configure(10 * 1024 ** 3);
    let polls = 0;
    const ctx: JobHandlerContext = {
      jobId: new ObjectId(),
      reportProgress: async () => {},
      shouldCancel: async () => {
        polls += 1;
        if (polls > 1) throw new Error('job lease lost');
        return false;
      },
    };
    const payload = parsePayload({
      assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
      libraryId: new ObjectId().toHexString(),
      outputDir: path.join(tmpDir, 'out'),
      mapleCli: cli,
      featuresEngine: 'classical',
    });

    const run = runPanoCli(payload, ['pano', 'stitch'], ctx);
    while (!(await Bun.file(pidFile).exists())) await Bun.sleep(20);
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    const cliAliveWhenNextDecodeAdmitted = budget.acquire(1024 ** 3).then((release) => {
      release();
      return alive(pid);
    });

    await expect(run).rejects.toThrow('job lease lost');
    expect(await cliAliveWhenNextDecodeAdmitted).toBe(false);
    expect(budget.snapshot().reservedBytes).toBe(0);
  }, 15_000);
});
