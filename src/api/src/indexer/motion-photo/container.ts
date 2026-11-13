import type { ByteSource } from './byte-source.ts';
import { startsWithFtyp } from './iso-bmff.ts';
import { detectSamsungSef } from './samsung-sef.ts';
import { still, type MotionClip, type MotionDetection, type StillKind } from './types.ts';
import { integerField, type ItemField, type MotionXmp } from './xmp-fields.ts';

const PRIMARY_MIME: Record<StillKind, string> = {
  jpeg: 'image/jpeg',
  heif: 'image/heic',
};
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime']);
const HEIF_PRIMARY_PADDING = 8;

type Item = ReadonlyMap<ItemField, string>;

interface Layout {
  primary: Item;
  video: Item;
  secondaryBytes: number;
}

/** Validates the Container directory shape: Primary first, MotionPhoto last, lengths on every secondary. */
// fallow-ignore-next-line complexity
function directoryLayout(xmp: MotionXmp): Layout | string {
  if (xmp.directories !== 1 || xmp.items.length < 2) {
    return 'Motion Photo Container directory is missing or incomplete';
  }
  if (xmp.items.some((item) => !item.has('Mime') || !item.has('Semantic'))) {
    return 'a Container item lacks Mime or Semantic';
  }
  const semantics = xmp.items.map((item) => item.get('Semantic'));
  if (semantics.filter((s) => s === 'Primary').length !== 1 || semantics[0] !== 'Primary') {
    return 'the first Container item must be the only Primary';
  }
  const motionCount = semantics.filter((s) => s === 'MotionPhoto').length;
  if (motionCount !== 1 || semantics.at(-1) !== 'MotionPhoto') {
    return 'the MotionPhoto item must be the only and final Container item';
  }
  const secondaries = xmp.items.slice(1);
  if (
    secondaries.some((item) => item.has('Padding') && integerField(item.get('Padding'), true) !== 0)
  ) {
    return 'a secondary Container item has non-zero Padding';
  }
  const lengths = secondaries.map((item) => integerField(item.get('Length'), true));
  if (lengths.some((length) => length === null)) return 'a secondary Container item lacks Length';
  const secondaryBytes = (lengths as number[]).reduce((sum, length) => sum + length, 0);
  return { primary: xmp.items[0]!, video: xmp.items.at(-1)!, secondaryBytes };
}

/**
 * A HEIC clip is wrapped in an `mpvd` box whose payload is the MP4. Samsung
 * may follow it with one `sefd` box that `Item:Length` also counts; the
 * playback range stops before it.
 */
async function heifPlaybackLength(
  source: ByteSource,
  videoStart: number,
  declaredLength: number,
): Promise<number | string> {
  const header = videoStart >= 8 ? await source.read(videoStart - 8, 8) : null;
  if (!header || header.toString('latin1', 4, 8) !== 'mpvd') {
    return 'HEIC Motion Photo is missing its mpvd box';
  }
  const payloadLength = header.readUInt32BE(0) - 8;
  if (payloadLength === declaredLength) return declaredLength;
  if (payloadLength <= 0 || payloadLength >= declaredLength) {
    return 'mpvd box size does not match Item:Length';
  }
  const trailerLength = declaredLength - payloadLength;
  const trailer = await source.read(videoStart + payloadLength, 8);
  const isSefd =
    trailer !== null &&
    trailer.toString('latin1', 4, 8) === 'sefd' &&
    trailer.readUInt32BE(0) === trailerLength;
  return isSefd ? payloadLength : 'bytes after mpvd are not one sefd box';
}

/** A modern Samsung JPEG's Item:Length can run to EOF over its SEF trailer; narrow to the indexed clip. */
async function narrowedBySef(source: ByteSource, clip: MotionClip): Promise<MotionClip> {
  const samsung = await detectSamsungSef(source);
  if (!samsung || !('motion' in samsung)) return clip;
  const indexed = samsung.motion;
  return indexed.start === clip.start && indexed.length < clip.length
    ? { ...clip, length: indexed.length }
    : clip;
}

/** Motion Photo 1.0 (`GCamera:MotionPhoto` + `Container:Directory`), the authoritative layout when present. */
// fallow-ignore-next-line complexity
export async function detectContainer(
  source: ByteSource,
  kind: StillKind,
  xmp: MotionXmp,
): Promise<MotionDetection> {
  if (xmp.camera.get('MotionPhoto')?.trim() !== '1') return still('MotionPhoto is not 1');
  if (integerField(xmp.camera.get('MotionPhotoVersion'), false) !== 1) {
    return still('MotionPhoto is set without MotionPhotoVersion 1');
  }
  const timestamp = xmp.camera.get('MotionPhotoPresentationTimestampUs');
  const parsedTimestamp = integerField(timestamp, false);
  if (timestamp !== undefined && (parsedTimestamp === null || parsedTimestamp < -1)) {
    return still('MotionPhotoPresentationTimestampUs is invalid');
  }
  const layout = directoryLayout(xmp);
  if (typeof layout === 'string') return still(layout);
  const { primary, video } = layout;
  if (primary.get('Mime') !== PRIMARY_MIME[kind])
    return still('Primary Mime does not match the file');
  const primaryLength = integerField(primary.get('Length'), true);
  if (primary.has('Length') && primaryLength !== 0) return still('Primary Length must be zero');
  const padding = primary.has('Padding') ? integerField(primary.get('Padding'), true) : 0;
  if (padding === null) return still('Primary Padding is invalid');
  if (kind === 'heif' && padding !== HEIF_PRIMARY_PADDING)
    return still('HEIC Primary Padding must be 8');
  const mime = video.get('Mime')!;
  if (!VIDEO_MIMES.has(mime)) return still(`unsupported Motion Photo video Mime ${mime}`);
  const declaredLength = integerField(video.get('Length'), true)!;
  if (declaredLength === 0) return still('MotionPhoto Length must be positive');
  if (padding + layout.secondaryBytes >= source.size) {
    return still('Container lengths reach past the start of the file');
  }
  const start = source.size - declaredLength;
  const length =
    kind === 'heif' ? await heifPlaybackLength(source, start, declaredLength) : declaredLength;
  if (typeof length === 'string') return still(length);
  if (!(await startsWithFtyp(source, start, length))) {
    return still('MotionPhoto range does not begin with an ftyp box');
  }
  const clip: MotionClip = { start, length, mime: mime as MotionClip['mime'] };
  return {
    motion: kind === 'jpeg' && mime === 'video/mp4' ? await narrowedBySef(source, clip) : clip,
  };
}
