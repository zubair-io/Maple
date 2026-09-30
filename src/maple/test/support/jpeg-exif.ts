/** Camera-style APP1 EXIF Orientation, spliced after a real JPEG's SOI.
 * Pure test fixture shared by the standalone package and API synthetic helpers.
 */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); // little-endian TIFF header
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 starts right after the header
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // type SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // inline value
  tiff.writeUInt32LE(0, 22); // no next IFD
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0); // APP1
  header.writeUInt16BE(2 + 6 + tiff.length, 2); // segment length
  const app1 = Buffer.concat([header, Buffer.from('Exif\0\0', 'binary'), tiff]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
