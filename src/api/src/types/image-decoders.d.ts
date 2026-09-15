// Declarations for the decoder APIs used here, verified against hdr 0.6.1
// (lib/hdr-load.js) and heic-convert 2.1.0 (lib.js, formats-node.js).
declare module 'hdr' {
  import { Writable } from 'node:stream';

  class HDRLoader extends Writable {
    width: number;
    height: number;
    data: Float32Array | null;
  }

  const HDR: { loader: typeof HDRLoader };
  export default HDR;
}

declare module 'heic-convert' {
  import type { Buffer } from 'node:buffer';

  export default function convert(options: {
    buffer: Uint8Array;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }): Promise<Buffer>;
}
