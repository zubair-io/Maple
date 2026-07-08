/**
 * ONE-SHOT Radiance HDR decode child process — decodes exactly one file,
 * replies, and exits. Never pooled or reused across requests.
 *
 * Why one-shot, unlike every other native child in this codebase (the
 * persistent `imgdecode` child, the FFI pool, the face-embed pool): the
 * `hdr` npm package cannot safely decode more than one real (multi-scanline,
 * RLE-compressed) file per process — a second call hangs forever, even when
 * called strictly after the first fully resolved (confirmed empirically; see
 * `psd-hdr-decode.ts`'s module doc for the full investigation). A persistent
 * pool would work fine for the FIRST HDR file and then wedge on the second.
 * Spawning fresh for every call sidesteps the bug entirely without needing
 * to understand or patch its exact root cause inside the library.
 *
 * Transport: Bun IPC, `serialization: 'advanced'` (carries the decoded
 * `Uint8Array` raster directly — there's no persistent child to instead
 * write a JPEG to disk itself, so the raw pixels cross the wire and the
 * caller finishes the sharp resize/encode step itself).
 */

import type { HdrDecodeRequest, HdrDecodeResponse } from './hdr-decode-protocol.ts';
import { installChildHardening } from '../runtime/child-process-worker.ts';
import { decodeHdrToneMapped } from './psd-hdr-decode.ts';

installChildHardening('hdr-decode');

function send(msg: HdrDecodeResponse): void {
  process.send?.(msg);
}

process.on('message', (raw: unknown) => {
  const req = raw as HdrDecodeRequest;
  if (!req || typeof req !== 'object' || req.type !== 'decode') return;

  void (async () => {
    try {
      const raster = await decodeHdrToneMapped(req.bytes);
      send({
        type: 'decode',
        ok: true,
        width: raster.width,
        height: raster.height,
        data: raster.data,
      });
    } catch (e) {
      send({
        type: 'decode',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // Exactly one decode per process, always — success or failure. Exiting
      // here (rather than waiting for the parent's `terminate()`) also means
      // a decode that DID hang can't happen: the only path that reaches this
      // `finally` is one where `decodeHdrToneMapped` already settled.
      process.exit(0);
    }
  })();
});
