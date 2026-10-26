import type { ByteSource } from './byte-source.ts';
import { startsWithFtyp } from './iso-bmff.ts';
import { still, type MotionDetection } from './types.ts';

const MOTION_PHOTO_DATA_TYPE = 0x0a30;
const MOTION_PHOTO_DATA_NAME = Buffer.from('MotionPhoto_Data', 'latin1');
const RECORD_HEADER_BYTES = 8 + MOTION_PHOTO_DATA_NAME.length;
const DIRECTORY_ENTRY_BYTES = 12;
const DIRECTORY_HEADER_BYTES = 12;
const MAX_DIRECTORY_BYTES = 64 * 1024;

interface SefRecord {
  padding: number;
  type: number;
  offsetBack: number;
  length: number;
}

function directoryRecords(directory: Buffer): SefRecord[] {
  const count = directory.readUInt32LE(8);
  return Array.from({ length: count }, (_, index) => {
    const at = DIRECTORY_HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
    return {
      padding: directory.readUInt16LE(at),
      type: directory.readUInt16LE(at + 2),
      offsetBack: directory.readUInt32LE(at + 4),
      length: directory.readUInt32LE(at + 8),
    };
  });
}

async function readDirectory(
  source: ByteSource,
): Promise<{ start: number; directory: Buffer } | MotionDetection | null> {
  if (source.size < 8) return null;
  const tail = await source.read(source.size - 8, 8);
  if (!tail || tail.toString('latin1', 4, 8) !== 'SEFT') return null;
  const length = tail.readUInt32LE(0);
  if (length < DIRECTORY_HEADER_BYTES || length > MAX_DIRECTORY_BYTES || length > source.size - 8) {
    return still('Samsung SEFT directory length is invalid');
  }
  const start = source.size - 8 - length;
  const directory = await source.read(start, length);
  if (!directory || directory.toString('latin1', 0, 4) !== 'SEFH') {
    return still('Samsung SEFT trailer does not point at an SEFH directory');
  }
  const count = directory.readUInt32LE(8);
  if (count === 0 || DIRECTORY_HEADER_BYTES + count * DIRECTORY_ENTRY_BYTES !== length) {
    return still('Samsung SEFH record count does not match its size');
  }
  return { start, directory };
}

async function clipFromRecord(
  source: ByteSource,
  directoryStart: number,
  record: SefRecord,
): Promise<MotionDetection> {
  if (record.padding !== 0 || record.offsetBack === 0 || record.offsetBack > directoryStart) {
    return still('Samsung MotionPhoto_Data index entry is out of range');
  }
  const recordStart = directoryStart - record.offsetBack;
  if (record.length <= RECORD_HEADER_BYTES || recordStart + record.length > directoryStart) {
    return still('Samsung MotionPhoto_Data record overlaps its directory');
  }
  const header = await source.read(recordStart, RECORD_HEADER_BYTES);
  const consistent =
    header !== null &&
    header.readUInt16LE(0) === 0 &&
    header.readUInt16LE(2) === MOTION_PHOTO_DATA_TYPE &&
    header.readUInt32LE(4) === MOTION_PHOTO_DATA_NAME.length &&
    header.subarray(8).equals(MOTION_PHOTO_DATA_NAME);
  if (!consistent) return still('Samsung MotionPhoto_Data record header is inconsistent');
  const clip = {
    start: recordStart + RECORD_HEADER_BYTES,
    length: record.length - RECORD_HEADER_BYTES,
    mime: 'video/mp4' as const,
  };
  return (await startsWithFtyp(source, clip.start, clip.length))
    ? { motion: clip }
    : still('Samsung MotionPhoto_Data does not begin with an ftyp box');
}

/**
 * The clip a Samsung JPEG indexes in its SEF trailer (`…SEFH directory,
 * u32 length, "SEFT"` at end of file), or null when the file carries no SEF
 * trailer or no `MotionPhoto_Data` record. SEF also stores many still-only
 * records, so a trailer without that record never makes a file motion.
 */
export async function detectSamsungSef(source: ByteSource): Promise<MotionDetection | null> {
  const found = await readDirectory(source);
  if (found === null || !('directory' in found)) return found;
  const records = directoryRecords(found.directory).filter(
    (record) => record.type === MOTION_PHOTO_DATA_TYPE,
  );
  if (records.length === 0) return null;
  if (records.length > 1) return still('Samsung SEF lists more than one MotionPhoto_Data record');
  return clipFromRecord(source, found.start, records[0]!);
}
