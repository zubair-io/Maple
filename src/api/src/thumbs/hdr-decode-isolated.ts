/**
 * Spawns a fresh, single-use child process per Radiance HDR decode — see
 * `hdr-decode.child.ts`'s module doc for why HDR specifically can't share
 * the persistent `imgdecode` child every other format uses.
 */

import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from '../runtime/child-process-worker.ts';
import type { HdrDecodeRequest, HdrDecodeResponse } from './hdr-decode-protocol.ts';
import type { DecodedRaster } from './psd-hdr-decode.ts';

const HDR_CHILD_SCRIPT = childScriptPath(import.meta.url, './hdr-decode.child.ts');

/** Generous but bounded: a real Radiance HDR thumbnail source is a handful
 * of megapixels at most; 30s covers cold process spawn + decode with margin
 * without letting a genuinely wedged child (a bug this design hasn't yet
 * anticipated) hold a thumbnail request open indefinitely. */
const HDR_DECODE_TIMEOUT_MS = 30_000;

/** Decode `bytes` in a fresh one-shot child, always killing the child
 * afterward (it self-exits on success/failure already, via `process.exit(0)`
 * in its own `finally` — this call additionally guards the case where it
 * doesn't, e.g. a hang the isolation itself doesn't anticipate, so this
 * function can never leak a child process). */
export async function decodeHdrIsolated(bytes: Uint8Array): Promise<DecodedRaster> {
  const worker = new ChildProcessWorker(HDR_CHILD_SCRIPT, {
    nice: DEFAULT_NATIVE_CHILD_NICE,
    label: 'hdr-decode',
  });

  try {
    return await new Promise<DecodedRaster>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`hdr-decode-isolated: timed out after ${HDR_DECODE_TIMEOUT_MS}ms`));
      }, HDR_DECODE_TIMEOUT_MS);
      // The pool infra already unrefs its own internal timers where it has
      // them; `setTimeout` here needs the same so a pending decode can't
      // keep the process alive past normal shutdown.
      (timer as unknown as { unref?: () => void }).unref?.();

      worker.addEventListener('message', (e) => {
        clearTimeout(timer);
        const res = e.data as HdrDecodeResponse;
        if (res.ok && res.width != null && res.height != null && res.data) {
          resolve({ width: res.width, height: res.height, data: res.data });
        } else {
          reject(new Error(res.error ?? 'hdr-decode-isolated: decode failed with no error detail'));
        }
      });
      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(e.message ?? 'hdr-decode-isolated: child died'));
      });

      const req: HdrDecodeRequest = { type: 'decode', bytes };
      worker.postMessage(req);
    });
  } finally {
    worker.terminate();
  }
}
