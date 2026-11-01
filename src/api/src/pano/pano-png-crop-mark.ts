/**
 * A stitched PNG that carries an Auto Crop records the rectangle in a `tEXt`
 * chunk (#5608). The pixels are the same as the uncropped stitch's, and the
 * library identifies a file by its bytes, so without the chunk the cropped and
 * uncropped panoramas would be one asset and the crop sidecar of one would
 * never reach the other. The chunk also keeps the file self-describing if its
 * sidecar is lost.
 */

import { open } from '../fs/mirrored.ts';
import type { PanoEdgesReport } from './pano-edges.ts';

export const CROP_MARK_KEYWORD = 'Maple Auto Crop';

const IEND = Buffer.from('0000000049454e44ae426082', 'hex');

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const frame = Buffer.alloc(8 + data.length + 4);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(Bun.hash.crc32(body), 8 + data.length);
  return frame;
}

export function cropMarkText(rect: NonNullable<PanoEdgesReport['auto_crop']['rect']>): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

/** Insert the mark before the closing `IEND` chunk of the PNG at `path`. */
export async function markPngWithCrop(
  path: string,
  rect: NonNullable<PanoEdgesReport['auto_crop']['rect']>,
): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(IEND.length);
    await handle.read(tail, 0, tail.length, size - tail.length);
    if (!tail.equals(IEND)) throw new Error(`pano: ${path} does not end with a PNG IEND chunk`);
    const mark = chunk(
      'tEXt',
      Buffer.from(`${CROP_MARK_KEYWORD}\0${cropMarkText(rect)}`, 'latin1'),
    );
    await handle.truncate(size - IEND.length);
    await handle.write(
      Buffer.concat([mark, IEND]),
      0,
      mark.length + IEND.length,
      size - IEND.length,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}
