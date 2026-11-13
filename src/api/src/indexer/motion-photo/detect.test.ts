import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as mirroredFs from '../../fs/mirrored.ts';
import { mkdtemp, readFile, rm, writeFile } from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceChangedError } from './byte-source.ts';
import { detectMotionPhoto, type FileMotionDetection } from './detect.ts';
import {
  box,
  containerXmp,
  heic,
  IMAGE_UTC_DATA,
  jpeg,
  MOTION_PHOTO_DATA,
  mp4,
  sefTrailer,
} from './motion-photo.fixtures.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maple-motion-photo-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function detect(name: string, bytes: Buffer): Promise<FileMotionDetection> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return detectMotionPhoto(path, new AbortController().signal);
}

async function clipBytes(name: string, detection: FileMotionDetection): Promise<string> {
  if (!('motion' in detection)) throw new Error(`expected motion, got ${detection.still}`);
  const bytes = await readFile(join(dir, name));
  const { start, length } = detection.motion;
  return bytes.subarray(start, start + length).toString('latin1');
}

function pixelMotionPhoto(clip: Buffer, overrides: Record<string, string> = {}): Buffer {
  const xmp = containerXmp(
    {
      MotionPhoto: '1',
      MotionPhotoVersion: '1',
      MotionPhotoPresentationTimestampUs: '968000',
      ...overrides,
    },
    [
      { mime: 'image/jpeg', semantic: 'Primary', length: 0, padding: 0 },
      {
        mime: 'video/mp4',
        semantic: 'MotionPhoto',
        length: clip.length,
        padding: 0,
      },
    ],
  );
  return Buffer.concat([jpeg(xmp), clip]);
}

function samsungHeic(clip: Buffer): Buffer {
  const sefd = box('sefd', Buffer.from('SEFH-like Samsung metadata', 'latin1'));
  const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
    { mime: 'image/heic', semantic: 'Primary', length: 0, padding: 8 },
    {
      mime: 'video/mp4',
      semantic: 'MotionPhoto',
      length: clip.length + sefd.length,
    },
  ]);
  const mpvdHeader = Buffer.alloc(8);
  mpvdHeader.writeUInt32BE(8 + clip.length);
  mpvdHeader.write('mpvd', 4, 'latin1');
  return Buffer.concat([heic(xmp), mpvdHeader, clip, sefd]);
}

describe('Motion Photo 1.0 (Pixel JPEG)', () => {
  test('promotes the MotionPhoto item at end of file', async () => {
    const result = await detect('PXL_1.MP.jpg', pixelMotionPhoto(mp4('pixel-clip')));
    expect('motion' in result && result.motion.mime).toBe('video/mp4');
    expect(await clipBytes('PXL_1.MP.jpg', result)).toBe(mp4('pixel-clip').toString('latin1'));
  });

  test('accepts alignment boxes ahead of ftyp', async () => {
    const clip = Buffer.concat([box('free', Buffer.alloc(16)), mp4('aligned')]);
    expect(
      await clipBytes('aligned.jpg', await detect('aligned.jpg', pixelMotionPhoto(clip))),
    ).toBe(clip.toString('latin1'));
  });

  test('treats MotionPhoto="0" as a still even with a valid clip appended', async () => {
    const result = await detect('off.jpg', pixelMotionPhoto(mp4(), { MotionPhoto: '0' }));
    expect(result).toEqual({ still: 'MotionPhoto is not 1' });
  });

  test('rejects junk where the clip should start', async () => {
    const clip = mp4();
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/jpeg', semantic: 'Primary' },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length + 40 },
    ]);
    const result = await detect('junk.jpg', Buffer.concat([jpeg(xmp), clip]));
    expect(result).toEqual({
      still: 'MotionPhoto range does not begin with an ftyp box',
    });
  });

  test('rejects a truncated clip', async () => {
    const whole = pixelMotionPhoto(mp4('will-be-cut'));
    const result = await detect('cut.jpg', whole.subarray(0, whole.length - 30));
    expect('still' in result).toBe(true);
  });

  test('rejects a Length longer than the file', async () => {
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/jpeg', semantic: 'Primary' },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: 10_000_000 },
    ]);
    expect(await detect('long.jpg', Buffer.concat([jpeg(xmp), mp4()]))).toEqual({
      still: 'Container lengths reach past the start of the file',
    });
  });

  test('tolerates Padding="0" on a secondary item but not a non-zero one', async () => {
    const clip = mp4();
    const withPadding = (padding: number) =>
      containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
        { mime: 'image/jpeg', semantic: 'Primary' },
        {
          mime: 'video/mp4',
          semantic: 'MotionPhoto',
          length: clip.length,
          padding,
        },
      ]);
    expect('motion' in (await detect('p0.jpg', Buffer.concat([jpeg(withPadding(0)), clip])))).toBe(
      true,
    );
    expect(await detect('p4.jpg', Buffer.concat([jpeg(withPadding(4)), clip]))).toEqual({
      still: 'a secondary Container item has non-zero Padding',
    });
  });

  test('requires MotionPhotoVersion 1', async () => {
    const result = await detect('v2.jpg', pixelMotionPhoto(mp4(), { MotionPhotoVersion: '2' }));
    expect(result).toEqual({
      still: 'MotionPhoto is set without MotionPhotoVersion 1',
    });
  });

  test('reports a QuickTime clip with its own content type', async () => {
    const clip = mp4('qt', 'qt  ');
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/jpeg', semantic: 'Primary' },
      { mime: 'video/quicktime', semantic: 'MotionPhoto', length: clip.length },
    ]);
    const result = await detect('qt.jpg', Buffer.concat([jpeg(xmp), clip]));
    expect('motion' in result && result.motion.mime).toBe('video/quicktime');
  });
});

describe('Motion Photo 1.0 directory shapes', () => {
  test('promotes the clip of an Ultra HDR file that also carries a gain map', async () => {
    const clip = mp4('ultra-hdr');
    const gainMap = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(300, 7)]);
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/jpeg', semantic: 'Primary', length: 0, padding: 0 },
      { mime: 'image/jpeg', semantic: 'GainMap', length: gainMap.length, padding: 0 },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length, padding: 0 },
    ]);
    const file = Buffer.concat([jpeg(xmp), gainMap, clip]);
    expect(await clipBytes('uhdr.jpg', await detect('uhdr.jpg', file))).toBe(
      clip.toString('latin1'),
    );
  });

  test('reads fields written as elements rather than attributes', async () => {
    const clip = mp4('elements');
    const item = (mime: string, semantic: string, length?: number) =>
      `<rdf:li rdf:parseType="Resource"><Container:Item rdf:parseType="Resource"><Item:Mime>${mime}</Item:Mime><Item:Semantic>${semantic}</Item:Semantic>${length === undefined ? '' : `<Item:Length>${length}</Item:Length>`}</Container:Item></rdf:li>`;
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/">
<GCamera:MotionPhoto>1</GCamera:MotionPhoto><GCamera:MotionPhotoVersion>1</GCamera:MotionPhotoVersion>
<Container:Directory><rdf:Seq>${item('image/jpeg', 'Primary')}${item('video/mp4', 'MotionPhoto', clip.length)}</rdf:Seq></Container:Directory>
</rdf:Description></rdf:RDF></x:xmpmeta>`;
    const file = Buffer.concat([jpeg(xmp), clip]);
    expect(await clipBytes('elements.jpg', await detect('elements.jpg', file))).toBe(
      clip.toString('latin1'),
    );
  });

  test('a field declared twice makes the packet untrusted', async () => {
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/jpeg', semantic: 'Primary' },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: mp4().length },
    ]).replace(
      '<Container:Directory>',
      '<GCamera:MotionPhoto>1</GCamera:MotionPhoto><Container:Directory>',
    );
    expect(await detect('twice.jpg', Buffer.concat([jpeg(xmp), mp4()]))).toEqual({
      still: 'no Motion Photo metadata',
    });
  });
});

describe('Samsung SEF (JPEG)', () => {
  const stillRecord = {
    type: IMAGE_UTC_DATA,
    name: 'Image_UTC_Data',
    data: Buffer.from('1696000000000'),
  };

  test('promotes the indexed MotionPhoto_Data record', async () => {
    const clip = mp4('samsung-clip');
    const file = Buffer.concat([
      jpeg(null),
      sefTrailer([stillRecord, { type: MOTION_PHOTO_DATA, name: 'MotionPhoto_Data', data: clip }]),
    ]);
    const result = await detect('20240101_120000.jpg', file);
    expect(await clipBytes('20240101_120000.jpg', result)).toBe(clip.toString('latin1'));
  });

  test('never promotes a still-only SEF trailer', async () => {
    const file = Buffer.concat([jpeg(null), sefTrailer([stillRecord])]);
    expect(await detect('still-sef.jpg', file)).toEqual({
      still: 'no Motion Photo metadata',
    });
  });

  test('narrows a Container Length that runs over the SEF trailer to the indexed clip', async () => {
    const clip = mp4('modern-samsung');
    const trailer = sefTrailer([{ type: MOTION_PHOTO_DATA, name: 'MotionPhoto_Data', data: clip }]);
    const recordHeader = 8 + 'MotionPhoto_Data'.length;
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/jpeg', semantic: 'Primary', length: 0, padding: 0 },
      {
        mime: 'video/mp4',
        semantic: 'MotionPhoto',
        length: trailer.length - recordHeader,
        padding: 0,
      },
    ]);
    const prefix = jpeg(xmp);
    const file = Buffer.concat([prefix, trailer]);
    const result = await detect('modern.jpg', file);
    expect(result).toEqual({
      motion: {
        start: prefix.length + recordHeader,
        length: clip.length,
        mime: 'video/mp4',
        sourceSize: file.length,
      },
    });
  });

  test('rejects a MotionPhoto_Data record whose payload is not a movie', async () => {
    const file = Buffer.concat([
      jpeg(null),
      sefTrailer([
        {
          type: MOTION_PHOTO_DATA,
          name: 'MotionPhoto_Data',
          data: Buffer.alloc(64, 7),
        },
      ]),
    ]);
    expect(await detect('bad-sef.jpg', file)).toEqual({
      still: 'Samsung MotionPhoto_Data does not begin with an ftyp box',
    });
  });
});

describe('Samsung HEIC (mpvd + sefd)', () => {
  test('promotes the mpvd payload and leaves the sefd trailer out of the range', async () => {
    const clip = mp4('heic-clip');
    const result = await detect('20240101_120000.heic', samsungHeic(clip));
    expect(await clipBytes('20240101_120000.heic', result)).toBe(clip.toString('latin1'));
  });

  test('reads XMP stored at a file offset rather than in idat', async () => {
    const clip = mp4();
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/heic', semantic: 'Primary', padding: 8 },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length },
    ]);
    const mpvd = box('mpvd', clip);
    const result = await detect('offset.heic', Buffer.concat([heic(xmp, 'file'), mpvd]));
    expect(await clipBytes('offset.heic', result)).toBe(clip.toString('latin1'));
  });

  test('rejects an mpvd box whose size disagrees with Item:Length', async () => {
    const clip = mp4();
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/heic', semantic: 'Primary', padding: 8 },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length + 20 },
    ]);
    const file = Buffer.concat([heic(xmp), box('mpvd', clip), Buffer.alloc(20, 9)]);
    expect(await detect('tail.heic', file)).toEqual({
      still: 'bytes after mpvd are not one sefd box',
    });
  });

  test('finds the XMP item behind hundreds of tile items', async () => {
    const clip = mp4('tiled');
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/heic', semantic: 'Primary', padding: 8 },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length },
    ]);
    const file = Buffer.concat([heic(xmp, 'idat', { tiles: 300 }), box('mpvd', clip)]);
    expect(await clipBytes('tiled.heic', await detect('tiled.heic', file))).toBe(
      clip.toString('latin1'),
    );
  });

  test('walks tens of thousands of items without exhausting the stack', async () => {
    const clip = mp4('many-items');
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/heic', semantic: 'Primary', padding: 8 },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length },
    ]);
    const file = Buffer.concat([heic(xmp, 'idat', { extraLocations: 65_000 }), box('mpvd', clip)]);
    expect(await clipBytes('items.heic', await detect('items.heic', file))).toBe(
      clip.toString('latin1'),
    );
  });

  test('ignores a meta box over 1 MB', async () => {
    const clip = mp4();
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/heic', semantic: 'Primary', padding: 8 },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length },
    ]);
    const file = Buffer.concat([heic(xmp, 'idat', { tiles: 60_000 }), box('mpvd', clip)]);
    expect(await detect('huge-meta.heic', file)).toEqual({ still: 'no Motion Photo metadata' });
  });

  test('rejects a HEIC clip without its mpvd box', async () => {
    const clip = mp4();
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/heic', semantic: 'Primary', padding: 8 },
      { mime: 'video/mp4', semantic: 'MotionPhoto', length: clip.length },
    ]);
    expect(await detect('bare.heic', Buffer.concat([heic(xmp), clip]))).toEqual({
      still: 'HEIC Motion Photo is missing its mpvd box',
    });
  });
});

describe('legacy Pixel MicroVideo', () => {
  const micro = (offset: number) =>
    containerXmp({
      MicroVideo: '1',
      MicroVideoVersion: '1',
      MicroVideoOffset: String(offset),
    });

  test('promotes the last MicroVideoOffset bytes', async () => {
    const clip = mp4('mvimg');
    const result = await detect('MVIMG_1.jpg', Buffer.concat([jpeg(micro(clip.length)), clip]));
    expect(await clipBytes('MVIMG_1.jpg', result)).toBe(clip.toString('latin1'));
  });

  test('ignores a stale MicroVideoOffset whose movie was stripped', async () => {
    expect(await detect('edited.jpg', jpeg(micro(300)))).toEqual({
      still: 'MicroVideoOffset does not point at an ftyp box',
    });
  });
});

test('a plain JPEG and a non-image are stills', async () => {
  expect(await detect('plain.jpg', jpeg(null))).toEqual({
    still: 'no Motion Photo metadata',
  });
  expect(await detect('notes.jpg', Buffer.from('not an image'))).toEqual({
    still: 'not a JPEG or HEIF still',
  });
});

test('a malformed XMP packet with a DTD is ignored rather than trusted', async () => {
  const clip = mp4();
  const xmp = `<!DOCTYPE x [<!ENTITY e "1">]>${containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' })}`;
  expect(await detect('dtd.jpg', Buffer.concat([jpeg(xmp), clip]))).toEqual({
    still: 'no Motion Photo metadata',
  });
});

test('a file that changes size while it is read throws for a retry', async () => {
  const path = join(dir, 'growing.jpg');
  await writeFile(path, pixelMotionPhoto(mp4()));
  const realStat = mirroredFs.stat;
  const spy = spyOn(mirroredFs, 'stat').mockImplementation((async (target: string) => {
    const stats = await realStat(target);
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      size: stats.size + 1,
    });
  }) as typeof mirroredFs.stat);
  try {
    await expect(detectMotionPhoto(path, new AbortController().signal)).rejects.toBeInstanceOf(
      SourceChangedError,
    );
  } finally {
    spy.mockRestore();
  }
});

test('an aborted signal stops detection', async () => {
  const path = join(dir, 'abort.jpg');
  await writeFile(path, pixelMotionPhoto(mp4()));
  const controller = new AbortController();
  controller.abort();
  await expect(detectMotionPhoto(path, controller.signal)).rejects.toThrow();
});
