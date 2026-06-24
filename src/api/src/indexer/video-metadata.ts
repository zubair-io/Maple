/**
 * Pure-JS QuickTime / MP4 (`.mov`/`.mp4`) metadata reader.
 *
 * iPhone videos carry their capture date + GPS in the `moov` atom, NOT in EXIF —
 * so `exifr` (image-only) returns nothing and the asset ends up undated/unplaced.
 * This walks the box tree and pulls:
 *   - capture date — `com.apple.quicktime.creationdate` (tz-aware, preferred) with
 *     the `mvhd` creation_time as a fallback,
 *   - GPS — `com.apple.quicktime.location.ISO6709`,
 *   - make / model — `com.apple.quicktime.make` / `…model`.
 *
 * No external binary (no exiftool/ffprobe). The file walk reads only box HEADERS
 * and the (small) `moov` payload — it never reads the `mdat` media body, so a
 * multi-hundred-MB clip costs a handful of small seeked reads.
 *
 * Box format: each box is `size(4 BE) + type(4 ascii) + payload`. `size == 1`
 * means a 64-bit `largesize` follows the type; `size == 0` means "to end of
 * container". `moov` may sit before or after `mdat` (iPhone puts it at the end).
 */

import * as fs from 'node:fs/promises';

export interface VideoMetadata {
  /** Normalised ISO-8601 capture date (tz preserved when known), or null. */
  creationDate: string | null;
  latitude: number | null;
  longitude: number | null;
  make: string | null;
  model: string | null;
}

const QUICKTIME_EPOCH_OFFSET_SECONDS = 2_082_844_800; // 1904-01-01 → 1970-01-01

const KEY_CREATIONDATE = 'com.apple.quicktime.creationdate';
const KEY_LOCATION = 'com.apple.quicktime.location.ISO6709';
const KEY_MAKE = 'com.apple.quicktime.make';
const KEY_MODEL = 'com.apple.quicktime.model';

interface BoxHeader {
  type: string;
  /** Total box length including the header. */
  size: number;
  /** Header length (8, or 16 for a 64-bit size). */
  headerLen: number;
}

/** Read one box header at `offset` within `buf`, or null when there isn't a full
 * header (or the declared size is malformed for the container). */
function readBoxHeader(buf: Buffer, offset: number, containerEnd: number): BoxHeader | null {
  if (offset + 8 > containerEnd) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let headerLen = 8;
  if (size === 1) {
    if (offset + 16 > containerEnd) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    headerLen = 16;
  } else if (size === 0) {
    size = containerEnd - offset; // extends to end of container
  }
  if (size < headerLen || offset + size > containerEnd) return null;
  return { type, size, headerLen };
}

/** Iterate child boxes of `buf` between `[start, end)`, calling `cb` with each
 * box's type and its payload subarray. Stops on the first malformed header. */
function walkBoxes(
  buf: Buffer,
  cb: (type: string, payload: Buffer) => void,
  start = 0,
  end = buf.length,
): void {
  let offset = start;
  while (offset + 8 <= end) {
    const h = readBoxHeader(buf, offset, end);
    if (!h) break;
    cb(h.type, buf.subarray(offset + h.headerLen, offset + h.size));
    offset += h.size;
  }
}

/** `mvhd` creation_time → ISO string (timezone-naive; used only as a fallback). */
function parseMvhd(payload: Buffer): string | null {
  if (payload.length < 8) return null;
  const version = payload.readUInt8(0); // followed by 3 flag bytes
  let creationSecs: number;
  if (version === 1) {
    if (payload.length < 12) return null;
    creationSecs = Number(payload.readBigUInt64BE(4));
  } else {
    creationSecs = payload.readUInt32BE(4);
  }
  const unixSecs = creationSecs - QUICKTIME_EPOCH_OFFSET_SECONDS;
  if (unixSecs <= 0 || !Number.isFinite(unixSecs)) return null;
  return new Date(unixSecs * 1000).toISOString();
}

/** Parse a `keys` box payload → ordered key names (1-indexed by the spec; the
 * returned array is 0-indexed, so key index `i` maps to `names[i - 1]`). */
function parseKeys(payload: Buffer): string[] {
  const names: string[] = [];
  if (payload.length < 8) return names;
  const entryCount = payload.readUInt32BE(4); // after version(1)+flags(3)
  let off = 8;
  for (let i = 0; i < entryCount; i++) {
    if (off + 8 > payload.length) break;
    const keySize = payload.readUInt32BE(off); // includes the 8-byte key header
    if (keySize < 8 || off + keySize > payload.length) break;
    // bytes [off+4, off+8) are the namespace ('mdta'); the value follows.
    names.push(payload.toString('utf8', off + 8, off + keySize));
    off += keySize;
  }
  return names;
}

/** Parse an `ilst` box payload → map of key-name → raw value bytes. Each child
 * box's type is the 1-based key index (a 32-bit int); its `data` box holds the
 * value after an 8-byte (typeIndicator + locale) prefix. */
function parseIlst(payload: Buffer, keyNames: string[]): Map<string, Buffer> {
  const values = new Map<string, Buffer>();
  walkBoxes(payload, (type, itemPayload) => {
    const idx = Buffer.from(type, 'latin1').readUInt32BE(0);
    const keyName = keyNames[idx - 1];
    if (!keyName) return;
    walkBoxes(itemPayload, (t2, dataPayload) => {
      if (t2 === 'data' && dataPayload.length >= 8) {
        values.set(keyName, dataPayload.subarray(8)); // skip typeIndicator(4)+locale(4)
      }
    });
  });
  return values;
}

/** `meta` is a FullBox in ISO-MP4 (4-byte version+flags before children) but a
 * plain box in QuickTime (`.mov`). Detect by where the first `hdlr` child sits. */
function metaChildrenStart(payload: Buffer): number {
  if (payload.toString('latin1', 4, 8) === 'hdlr') return 0; // plain (qt)
  if (payload.toString('latin1', 8, 12) === 'hdlr') return 4; // fullbox (iso)
  return 0; // default to plain
}

/** ISO-6709 (`+48.8041+002.1176+010.000/`) → decimal lat/lng. */
export function parseISO6709(s: string): { lat: number; lng: number } | null {
  const m = s.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Insert a colon into a bare `±HHMM` timezone so `new Date()` parses it
 * (`2026-04-05T11:26:20-0700` → `…-07:00`). Leaves `Z`/offset-with-colon alone. */
export function normalizeCreationDate(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0) return null;
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? null : fixed;
}

/** Parse a `moov` box payload into `VideoMetadata`. Pure — unit-tested against
 * hand-built atom buffers. */
export function parseMoov(moov: Buffer): VideoMetadata {
  let mvhdDate: string | null = null;
  let keysDate: string | null = null;
  let latitude: number | null = null;
  let longitude: number | null = null;
  let make: string | null = null;
  let model: string | null = null;

  const handleMeta = (metaPayload: Buffer): void => {
    let keyNames: string[] = [];
    let ilstPayload: Buffer | null = null;
    walkBoxes(
      metaPayload,
      (type, payload) => {
        if (type === 'keys') keyNames = parseKeys(payload);
        else if (type === 'ilst') ilstPayload = payload;
      },
      metaChildrenStart(metaPayload),
    );
    if (!ilstPayload || keyNames.length === 0) return;
    const values = parseIlst(ilstPayload, keyNames);
    const cd = values.get(KEY_CREATIONDATE);
    if (cd) keysDate = normalizeCreationDate(cd.toString('utf8'));
    const loc = values.get(KEY_LOCATION);
    if (loc) {
      const gps = parseISO6709(loc.toString('utf8'));
      if (gps) {
        latitude = gps.lat;
        longitude = gps.lng;
      }
    }
    const mk = values.get(KEY_MAKE);
    if (mk) make = mk.toString('utf8').trim() || null;
    const md = values.get(KEY_MODEL);
    if (md) model = md.toString('utf8').trim() || null;
  };

  walkBoxes(moov, (type, payload) => {
    if (type === 'mvhd') mvhdDate = parseMvhd(payload);
    else if (type === 'meta') handleMeta(payload);
    else if (type === 'udta') {
      // Some files nest `meta` under `udta`.
      walkBoxes(payload, (t2, p2) => {
        if (t2 === 'meta') handleMeta(p2);
      });
    }
  });

  return {
    creationDate: keysDate ?? mvhdDate,
    latitude,
    longitude,
    make,
    model,
  };
}

/** Read the first top-level box of `type` (its payload) from an open file,
 * seeking past intervening boxes (notably `mdat`) without reading their bodies. */
async function readTopLevelBox(
  fh: fs.FileHandle,
  fileSize: number,
  wantType: string,
): Promise<Buffer | null> {
  const header = Buffer.alloc(16);
  let offset = 0;
  while (offset + 8 <= fileSize) {
    await fh.read(header, 0, 16, offset);
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerLen = 8;
    if (size === 1) {
      size = Number(header.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerLen || offset + size > fileSize) return null;
    if (type === wantType) {
      const payloadLen = size - headerLen;
      const payload = Buffer.alloc(payloadLen);
      await fh.read(payload, 0, payloadLen, offset + headerLen);
      return payload;
    }
    offset += size;
  }
  return null;
}

/**
 * Read QuickTime/MP4 metadata from a video file. Returns `null` when the file
 * has no `moov` box (not a valid container) — the caller treats that as
 * "no metadata", same as an image with no EXIF.
 */
export async function readVideoMetadata(absPath: string): Promise<VideoMetadata | null> {
  const fh = await fs.open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    const moov = await readTopLevelBox(fh, size, 'moov');
    if (!moov) return null;
    return parseMoov(moov);
  } finally {
    await fh.close();
  }
}
