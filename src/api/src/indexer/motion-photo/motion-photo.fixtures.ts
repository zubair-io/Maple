// Structurally faithful Motion Photo files built from the published layouts:
// Google's Motion Photo format 1.0 (Container directory + MotionPhoto item at
// EOF), the legacy Pixel MicroVideo XMP, Samsung's SEF trailer (records +
// SEFH directory + SEFT footer) and the Samsung HEIC `mpvd` + `sefd` tail.
// No real camera samples are committed; every byte here is synthetic.

const u16be = (value: number) => Buffer.from([value >> 8, value & 0xff]);
const u32be = (value: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
};
const u16le = (value: number) => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
};
const u32le = (value: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
};

export function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32be(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

export const fullBox = (type: string, version: number, ...payload: Buffer[]) =>
  box(type, Buffer.from([version, 0, 0, 0]), ...payload);

/** A HEIF `meta` box: a `pict` handler followed by the given child boxes. */
export const heifMeta = (...children: Buffer[]) =>
  fullBox(
    'meta',
    0,
    fullBox('hdlr', 0, Buffer.alloc(4), Buffer.from('pict', 'latin1'), Buffer.alloc(13)),
    ...children,
  );

/** A small MP4: `ftyp`, an empty `moov`, and an `mdat` carrying `marker` so a range is recognisable. */
export function mp4(marker = 'clip-payload', brand = 'isom'): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from(brand, 'latin1'), u32be(0x200), Buffer.from('isommp42', 'latin1')),
    box('moov', box('mvhd', Buffer.alloc(100))),
    box('mdat', Buffer.from(marker, 'latin1')),
  ]);
}

export interface ContainerItemSpec {
  mime: string;
  semantic: string;
  length?: number;
  padding?: number;
}

export function containerXmp(
  camera: Record<string, string>,
  items: readonly ContainerItemSpec[] = [],
): string {
  const cameraAttributes = Object.entries(camera)
    .map(([key, value]) => ` GCamera:${key}="${value}"`)
    .join('');
  const itemXml = items
    .map((item) => {
      const length = item.length === undefined ? '' : ` Item:Length="${item.length}"`;
      const padding = item.padding === undefined ? '' : ` Item:Padding="${item.padding}"`;
      return `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="${item.mime}" Item:Semantic="${item.semantic}"${length}${padding}/></rdf:li>`;
    })
    .join('');
  const directory =
    items.length === 0
      ? ''
      : `<Container:Directory><rdf:Seq>${itemXml}</rdf:Seq></Container:Directory>`;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"${cameraAttributes}>${directory}</rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/** SOI, an APP1 XMP segment, a quantisation table, a scan with fake entropy data, EOI. */
export function jpeg(xmp: string | null): Buffer {
  const app1 = (payload: Buffer) =>
    Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(payload.length + 2), payload]);
  const xmpSegment =
    xmp === null
      ? Buffer.alloc(0)
      : app1(
          Buffer.concat([
            Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
            Buffer.from(xmp),
          ]),
        );
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(32)])),
    xmpSegment,
    Buffer.from([0xff, 0xdb]),
    u16be(67),
    Buffer.alloc(65, 1),
    Buffer.from([0xff, 0xda]),
    u16be(8),
    Buffer.alloc(6, 2),
    Buffer.alloc(512, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export interface SefRecordSpec {
  type: number;
  name: string;
  data: Buffer;
}

/** Samsung SEF records, then the SEFH directory indexing them, then the SEFT footer. */
export function sefTrailer(records: readonly SefRecordSpec[]): Buffer {
  const encoded = records.map((record) =>
    Buffer.concat([
      u16le(0),
      u16le(record.type),
      u32le(record.name.length),
      Buffer.from(record.name, 'latin1'),
      record.data,
    ]),
  );
  const body = Buffer.concat(encoded);
  const starts = encoded.map((_, index) =>
    encoded.slice(0, index).reduce((sum, record) => sum + record.length, 0),
  );
  const entries = encoded.map((record, index) =>
    Buffer.concat([
      u16le(0),
      u16le(records[index]!.type),
      u32le(body.length - starts[index]!),
      u32le(record.length),
    ]),
  );
  const directory = Buffer.concat([
    Buffer.from('SEFH', 'latin1'),
    u32le(107),
    u32le(records.length),
    ...entries,
  ]);
  return Buffer.concat([body, directory, u32le(directory.length), Buffer.from('SEFT', 'latin1')]);
}

export const MOTION_PHOTO_DATA = 0x0a30;
export const IMAGE_UTC_DATA = 0x0001;

/**
 * A HEIC with its XMP as a `mime` item stored in `idat` (or at a file offset), plus an `mdat`.
 * `tiles` image items (declared in `iinf` and located in `iloc`, as a grid image's tiles
 * are) and `extraLocations` further `iloc` entries precede the XMP item.
 */
export function heic(
  xmp: string,
  storage: 'idat' | 'file' = 'idat',
  { tiles = 0, extraLocations = 0 } = {},
): Buffer {
  const tileIds = Array.from({ length: tiles }, (_, index) => 3 + index);
  const locationIds = [...tileIds, ...Array.from({ length: extraLocations }, () => 1)];
  const ftyp = box(
    'ftyp',
    Buffer.from('heic', 'latin1'),
    u32be(0),
    Buffer.from('mif1heic', 'latin1'),
  );
  const xmpBytes = Buffer.from(xmp);
  const infe = (id: number, type: string, tail: Buffer) =>
    fullBox('infe', 2, u16be(id), u16be(0), Buffer.from(type, 'latin1'), tail);
  const iinf = fullBox(
    'iinf',
    0,
    u16be(2 + tiles),
    infe(1, 'hvc1', Buffer.from('\0', 'latin1')),
    ...tileIds.map((id) => infe(id, 'hvc1', Buffer.from('\0', 'latin1'))),
    infe(2, 'mime', Buffer.from('XMP\0application/rdf+xml\0', 'latin1')),
  );
  const build = (xmpOffset: number) => {
    const iloc = fullBox(
      'iloc',
      1,
      Buffer.from([0x44, 0x00]),
      u16be(1 + locationIds.length),
      ...locationIds.map((id) => Buffer.concat([u16be(id), u16be(0), u16be(0), u16be(0)])),
      u16be(2),
      u16be(storage === 'idat' ? 1 : 0),
      u16be(0),
      u16be(1),
      u32be(xmpOffset),
      u32be(xmpBytes.length),
    );
    const idat = storage === 'idat' ? box('idat', xmpBytes) : Buffer.alloc(0);
    const meta = heifMeta(iinf, iloc, idat);
    const mdat = box(
      'mdat',
      Buffer.alloc(256, 0x33),
      storage === 'file' ? xmpBytes : Buffer.alloc(0),
    );
    return { meta, mdat };
  };
  const draft = build(0);
  const fileOffset = ftyp.length + draft.meta.length + draft.mdat.length - xmpBytes.length;
  const final = build(storage === 'idat' ? 0 : fileOffset);
  return Buffer.concat([ftyp, final.meta, final.mdat]);
}
