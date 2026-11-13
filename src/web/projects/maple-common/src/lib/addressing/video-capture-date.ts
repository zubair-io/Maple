// A video's capture date for the Hosted-mode `maple_id` primary form (#5079).
//
// DELIBERATE DUPLICATE, ported from `src/api/src/indexer/video-metadata.ts`
// (`readTopLevelBox` + `parseMoov`, date fields only) and the `asIsoDate`
// normalisation in `exif.ts`: the server dates every `VIDEO_EXTS` file from
// its QuickTime `moov` atom and never from EXIF, so a browser that reads EXIF
// for a `.mov` derives a different id (or the fallback form) for the same
// bytes. `maple-id-contract.test.ts` pins this port against the server's
// reader on the shared `test-fixtures/ids` corpus, and the Swift port
// (`VideoCaptureDate.swift`) is pinned against the same corpus.
//
// The moov payload is the only part of the file read: top-level box headers
// are walked by ranged `Blob.slice` reads, so a multi-hundred-MB clip whose
// `moov` follows its `mdat` costs a handful of small reads.

import { asIsoDate } from './captured-at';

const QUICKTIME_EPOCH_OFFSET_SECONDS = 2_082_844_800; // 1904-01-01 → 1970-01-01
const KEY_CREATIONDATE = 'com.apple.quicktime.creationdate';

const utf8 = new TextDecoder('utf-8');

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

interface BoxHeader {
  type: string;
  /** Total box length including the header. */
  size: number;
  /** Header length (8, or 16 for a 64-bit size). */
  headerLen: number;
}

/** The server's `readBoxHeader`: null when there isn't a full header or the
 * declared size is malformed for the container. */
function readBoxHeader(buf: Uint8Array, offset: number, containerEnd: number): BoxHeader | null {
  if (offset + 8 > containerEnd) return null;
  const dv = view(buf);
  let size = dv.getUint32(offset);
  const type = latin1(buf, offset + 4, offset + 8);
  let headerLen = 8;
  if (size === 1) {
    if (offset + 16 > containerEnd) return null;
    size = Number(dv.getBigUint64(offset + 8));
    headerLen = 16;
  } else if (size === 0) {
    size = containerEnd - offset;
  }
  if (size < headerLen || offset + size > containerEnd) return null;
  return { type, size, headerLen };
}

/** The server's `walkBoxes`: children of `buf[start, end)`, stopping at the
 * first malformed header. */
function walkBoxes(
  buf: Uint8Array,
  cb: (type: string, payload: Uint8Array) => void,
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

/** `mvhd` creation_time → ISO string; null for a zero/pre-epoch value. */
function parseMvhd(payload: Uint8Array): string | null {
  if (payload.length < 8) return null;
  const dv = view(payload);
  let creationSecs: number;
  if (payload[0] === 1) {
    if (payload.length < 12) return null;
    creationSecs = Number(dv.getBigUint64(4));
  } else {
    creationSecs = dv.getUint32(4);
  }
  const unixSecs = creationSecs - QUICKTIME_EPOCH_OFFSET_SECONDS;
  if (unixSecs <= 0 || !Number.isFinite(unixSecs)) return null;
  const date = new Date(unixSecs * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `keys` payload → ordered key names (key index `i` maps to `names[i - 1]`). */
function parseKeys(payload: Uint8Array): string[] {
  const names: string[] = [];
  if (payload.length < 8) return names;
  const dv = view(payload);
  const entryCount = dv.getUint32(4);
  let off = 8;
  for (let i = 0; i < entryCount; i++) {
    if (off + 8 > payload.length) break;
    const keySize = dv.getUint32(off);
    if (keySize < 8 || off + keySize > payload.length) break;
    names.push(utf8.decode(payload.subarray(off + 8, off + keySize)));
    off += keySize;
  }
  return names;
}

/** The last value stored under `com.apple.quicktime.creationdate` in an
 * `ilst`; each child box's type is the 1-based key index. */
function creationDateValue(ilst: Uint8Array, keyNames: string[]): Uint8Array | null {
  let value: Uint8Array | null = null;
  walkBoxes(ilst, (type, itemPayload) => {
    const idx = [...type].reduce((acc, c) => acc * 256 + c.charCodeAt(0), 0);
    if (keyNames[idx - 1] !== KEY_CREATIONDATE) return;
    walkBoxes(itemPayload, (t2, dataPayload) => {
      if (t2 === 'data' && dataPayload.length >= 8) value = dataPayload.subarray(8);
    });
  });
  return value;
}

/** `meta` is a FullBox in ISO-MP4 but a plain box in QuickTime. */
function metaChildrenStart(payload: Uint8Array): number {
  if (latin1(payload, 4, 8) === 'hdlr') return 0;
  if (latin1(payload, 8, 12) === 'hdlr') return 4;
  return 0;
}

/** The server's `normalizeCreationDate`: a bare `±HHMM` zone gains its colon;
 * null when `new Date` rejects the result. */
function normalizeCreationDate(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0) return null;
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Number.isNaN(new Date(fixed).getTime()) ? null : fixed;
}

/** The `creationDate` of the server's `parseMoov`: the creationdate key of the
 * last `meta` that carries one (an unusable value still overrides an earlier
 * one), else `mvhd`. */
function creationDate(moov: Uint8Array): string | null {
  let mvhdDate: string | null = null;
  let keysDate: string | null = null;

  const handleMeta = (metaPayload: Uint8Array): void => {
    let keyNames: string[] = [];
    let ilst: Uint8Array | null = null;
    walkBoxes(
      metaPayload,
      (type, payload) => {
        if (type === 'keys') keyNames = parseKeys(payload);
        else if (type === 'ilst') ilst = payload;
      },
      metaChildrenStart(metaPayload),
    );
    if (!ilst || keyNames.length === 0) return;
    const value = creationDateValue(ilst, keyNames);
    if (value) keysDate = normalizeCreationDate(utf8.decode(value));
  };

  walkBoxes(moov, (type, payload) => {
    if (type === 'mvhd') mvhdDate = parseMvhd(payload);
    else if (type === 'meta') handleMeta(payload);
    else if (type === 'udta') {
      walkBoxes(payload, (t2, p2) => {
        if (t2 === 'meta') handleMeta(p2);
      });
    }
  });
  return keysDate ?? mvhdDate;
}

/** The first top-level `moov` payload of `file`, seeking past other boxes
 * (notably `mdat`) without reading their bodies — the server's
 * `readTopLevelBox`. */
async function readMoov(file: Blob): Promise<Uint8Array | null> {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    if (header.length < 8) return null;
    const dv = view(header);
    let size = dv.getUint32(0);
    let headerLen = 8;
    if (size === 1) {
      if (header.length < 16) return null;
      size = Number(dv.getBigUint64(8));
      headerLen = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < headerLen || offset + size > file.size) return null;
    if (latin1(header, 4, 8) === 'moov') {
      return new Uint8Array(await file.slice(offset + headerLen, offset + size).arrayBuffer());
    }
    offset += size;
  }
  return null;
}

/**
 * The ISO 8601 UTC capture date (`2026-04-05T18:26:20.000Z`) the server's
 * indexer stamps on this video, or null when the file has no `moov` atom or no
 * usable date — the fallback-form branch.
 */
export async function videoCaptureDate(file: Blob): Promise<string | null> {
  const moov = await readMoov(file);
  if (!moov) return null;
  const date = creationDate(moov);
  return date === null ? null : asIsoDate(date);
}
