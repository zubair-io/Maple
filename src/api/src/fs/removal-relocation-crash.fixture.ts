/** Real filesystem/process-loss fixture for #1472; no sidecar mocks. */
import * as fs from './mirrored.ts';
import { xmpSidecarPath } from './xmp.ts';
import { relocateFile } from './relocate.ts';
import { createRemovalJournal, syncRemovalDirectory } from './removal-relocation-journal.ts';
import { removalRelocationLease } from './removal-relocation-lease.ts';
import { removalRecords } from './removal-records.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { dirname } from 'node:path';

const [source, target, phase] = process.argv.slice(2);
const ready = async () => {
  await ffiPool().shutdown();
  process.send?.({ ready: true });
  // The test kills this real owner. IPC keeps the process alive without a
  // production fault hook, environment switch or mock filesystem layer.
  await new Promise<void>((resolve) => process.once('message', () => resolve()));
};

if (phase === 'complete') {
  const outcome = await relocateFile({
    sourceAbsPath: source,
    destAbsPath: target,
    mode: 'move',
    collision: 'replace',
    onVerified: ready,
  });
  throw new Error(`Crash fixture unexpectedly completed: ${JSON.stringify(outcome)}`);
} else {
  const lease = await removalRelocationLease(source, target);
  try {
    const xmp = xmpSidecarPath(source);
    const bytes = await fs.readFile(xmp);
    await ffiPool().verifyRemovalAssets(source, removalRecords(bytes.toString())!);
    if (phase === 'leased') {
      await ready();
      process.exit(0);
    }
    await createRemovalJournal(
      source,
      target,
      [source, xmp],
      [
        { target, source },
        { target: xmpSidecarPath(target), bytes },
      ],
    );
    if (phase === 'partial') {
      const temporary = `${target}.tmp.crash-fixture`;
      await fs.copyFile(source, temporary);
      const handle = await fs.open(temporary, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
      await syncRemovalDirectory(dirname(target));
    }
    await ready();
  } finally {
    await lease.release();
  }
}
