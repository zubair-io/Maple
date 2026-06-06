/**
 * Bridge the inline drop-in's replication-failure sink into the durable
 * `mirror_queue`, so a copy that failed during a live write (e.g. the mirror
 * was briefly unreachable) is retried by the mirror copy worker rather than
 * only logged. Install once per process that performs mirrored writes — both
 * the API process (backup ingest / XMP / uploads) and the worker process
 * (migration relocations) write through `fs/mirrored.ts`.
 */

import { onMirrorFailure, type MirrorFailure } from '../../fs/mirrored.ts';
import { enqueueMirrorCopy } from '../../fs/mirror-queue.repo.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('mirror-sink');

let _installed = false;

/** Idempotent — installs the enqueue-on-failure sink at most once per process. */
export function installMirrorQueueSink(): void {
  if (_installed) return;
  _installed = true;
  onMirrorFailure((f: MirrorFailure) => {
    // Only file replications are retryable by copying. mkdir/rm/rmdir/unlink
    // failures on the mirror aren't copy work; the scan pass reconciles
    // presence drift, and stray mirror files are left for a future scrub.
    if (f.op !== 'replicate') {
      log.warn(
        { op: f.op, mirrorPath: f.mirrorPath, err: f.error.message },
        'non-replicate mirror op failed — not queued',
      );
      return;
    }
    void enqueueMirrorCopy(f.sourcePath, f.mirrorPath, 'write-failure').catch((err) => {
      log.error(
        { mirrorPath: f.mirrorPath, err: err instanceof Error ? err.message : err },
        'failed to enqueue mirror retry — drift will be caught by the next scan',
      );
    });
  });
}
