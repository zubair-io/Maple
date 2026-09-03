// gate-image.ts — a fixture-free image for the editor gates (#2451). The
// production artifact job runs without the gitignored RAW fixtures, and the
// cross-width gates only need SOMETHING the editor can open, so this writes
// a 64×64 RGB gradient PNG at test time (the Hosted landing accepts any
// `image/*` and develops it through the same non-RAW WASM path as a JPEG).
import { deflateSync } from 'node:zlib';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** A 64×64 RGB gradient PNG, byte-identical on every run. */
export function gatePng(size = 64): Buffer {
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    rows[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      rows[i] = (x * 4) % 256;
      rows[i + 1] = (y * 4) % 256;
      rows[i + 2] = ((x + y) * 2) % 256;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Write the gate image to a fresh temp dir and return its path. */
export async function writeGatePng(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maple-editor-gate-'));
  const path = join(dir, 'gate.png');
  await writeFile(path, gatePng());
  return path;
}
