import { readFileSync } from 'node:fs';

export const CAMERA_MAKE = 'Maple Test';
export const CAMERA_MODEL = 'Cold Export Fixture';
export const LENS_MODEL = 'Prime';

/** Add matching capture metadata to an in-memory copy of the committed 64×64
 * grey DNG. Existing pixel data/IFD offsets stay intact; the original is read-only. */
export function lensExportFixture(path: string): Uint8Array {
  const original = readFileSync(path);
  if (original.toString('ascii', 0, 2) !== 'II' || original.readUInt16LE(2) !== 42)
    throw new Error('Expected the committed little-endian classic TIFF fixture');
  const parts: Buffer[] = [Buffer.from(original)];
  let size = original.length;
  const append = (bytes: Buffer): number => {
    if (size % 2) {
      parts.push(Buffer.alloc(1));
      size++;
    }
    const offset = size;
    parts.push(bytes);
    size += bytes.length;
    return offset;
  };
  const entry = (tag: number, type: number, count: number, value: Buffer): Buffer => {
    const record = Buffer.alloc(12);
    record.writeUInt16LE(tag, 0);
    record.writeUInt16LE(type, 2);
    record.writeUInt32LE(count, 4);
    if (value.length <= 4) value.copy(record, 8);
    else record.writeUInt32LE(append(value), 8);
    return record;
  };
  const text = (tag: number, value: string): Buffer => {
    const bytes = Buffer.from(value + '\0');
    return entry(tag, 2, bytes.length, bytes);
  };
  const rational = (tag: number, value: number): Buffer => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE(value, 0);
    bytes.writeUInt32LE(1, 4);
    return entry(tag, 5, 1, bytes);
  };
  const ifd = (entries: Buffer[]): number => {
    entries.sort((a, b) => a.readUInt16LE() - b.readUInt16LE());
    const table = Buffer.alloc(2 + entries.length * 12 + 4);
    table.writeUInt16LE(entries.length);
    entries.forEach((record, index) => record.copy(table, 2 + index * 12));
    return append(table);
  };
  const exif = ifd([
    rational(33437, 4), // FNumber
    rational(37382, 4), // SubjectDistance, metres
    rational(37386, 35), // FocalLength, mm
    text(42036, LENS_MODEL),
  ]);
  const exifPointer = Buffer.alloc(4);
  exifPointer.writeUInt32LE(exif);
  const entries = [
    text(271, CAMERA_MAKE),
    text(272, CAMERA_MODEL),
    text(50708, CAMERA_MODEL),
    entry(34665, 4, 1, exifPointer),
  ];
  const replaced = new Set(entries.map((record) => record.readUInt16LE()));
  const offset = original.readUInt32LE(4);
  for (let i = 0; i < original.readUInt16LE(offset); i++) {
    const record = original.subarray(offset + 2 + i * 12, offset + 14 + i * 12);
    if (!replaced.has(record.readUInt16LE())) entries.push(Buffer.from(record));
  }
  const root = ifd(entries);
  const result = Buffer.concat(parts);
  result.writeUInt32LE(root, 4);
  return result;
}

/** Authored test coefficients, never a redistributed third-party profile. */
export function lensExportProfile(vignette: number): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    xmlns:p="http://ns.adobe.com/photoshop/1.0/" xmlns:c="http://ns.adobe.com/photoshop/1.0/camera-profile">
    <r:RDF><r:Description><p:CameraProfiles><r:Seq>
    <r:li c:Make="${CAMERA_MAKE}" c:Model="${CAMERA_MODEL}" c:Lens="${LENS_MODEL}"
      c:CameraRawProfile="True" c:SensorFormatFactor="1" c:FocalLength="35"
      c:ApertureValue="4" c:FocusDistance="4" c:ImageWidth="64" c:ImageLength="64">
      <c:PerspectiveModel c:Version="2" c:RadialDistortParam1="0">
        <c:VignetteModel c:VignetteModelParam1="${vignette}"/>
      </c:PerspectiveModel>
    </r:li></r:Seq></p:CameraProfiles></r:Description></r:RDF></x:xmpmeta>`;
}
