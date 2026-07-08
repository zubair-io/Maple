/**
 * Wire protocol for the one-shot HDR decode child (`hdr-decode.child.ts`).
 *
 * Unlike the persistent `imgdecode` child (which handles every JPEG/HEIC/
 * PSD/etc. request for the process's whole lifetime), a fresh child process
 * is spawned for EVERY Radiance HDR decode and terminated immediately after
 * — see `hdr-decode.child.ts`'s module doc for why. The decoded raster
 * crosses IPC directly (Bun's `serialization: 'advanced'` carries typed
 * arrays), since there's no long-lived child to have write it to disk itself.
 */

export interface HdrDecodeRequest {
  type: 'decode';
  /** Raw HDR file bytes. */
  bytes: Uint8Array;
}

export interface HdrDecodeResponse {
  type: 'decode';
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  /** Interleaved RGBA8, present only when `ok`. */
  data?: Uint8Array;
}
