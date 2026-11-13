import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from '../../fs/mirrored.ts';
import { appleContentIdentifier } from './apple-makernote.ts';
import { readLiveContentId } from './content-id.ts';
import {
  appleTiff,
  heicWithExif,
  jpegWithExif,
  quickTimeClip,
  type QuickTimeClipSpec,
} from './live-photo.fixtures.ts';

const ID = '3F2A8C1E-9B47-4D55-A6E0-0C7D1B2E4F90';
const signal = new AbortController().signal;

describe('appleContentIdentifier', () => {
  it.each([
    ['big-endian TIFF and MakerNote', 'MM', 'MM'],
    ['little-endian TIFF and MakerNote', 'II', 'II'],
    ['big-endian TIFF with a little-endian MakerNote', 'MM', 'II'],
  ] as const)('reads tag 0x0011 from %s', (_name, tiffOrder, noteOrder) => {
    expect(appleContentIdentifier(appleTiff({ contentId: ID, tiffOrder, noteOrder }))).toBe(ID);
  });

  it('is null when the MakerNote has no content identifier tag', () => {
    expect(appleContentIdentifier(appleTiff({ contentId: null }))).toBeNull();
  });

  it('is null for a MakerNote that is not Apple iOS', () => {
    const tiff = appleTiff({ contentId: ID, makerNoteHeader: 'Nikon\0\x02\x10\0\0' });
    expect(appleContentIdentifier(tiff)).toBeNull();
  });

  it('is null for blocks too short or malformed to hold the tag', () => {
    const tiff = appleTiff({ contentId: ID });
    expect(appleContentIdentifier(Buffer.alloc(0))).toBeNull();
    expect(appleContentIdentifier(Buffer.from('MM\0*\0\0\0\x08'))).toBeNull();
    expect(appleContentIdentifier(tiff.subarray(0, tiff.length - 20))).toBeNull();
    expect(appleContentIdentifier(Buffer.concat([Buffer.from('XX'), tiff.subarray(2)]))).toBeNull();
  });
});

describe('readLiveContentId', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'live-content-id-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, bytes: Buffer): Promise<string> {
    const target = path.join(dir, name);
    await writeFile(target, bytes);
    return target;
  }

  it('reads the identifier of a JPEG still', async () => {
    const file = await write('a.jpg', jpegWithExif(appleTiff({ contentId: ID })));
    expect(await readLiveContentId(file, 'still', signal)).toBe(ID);
  });

  it('reads the identifier of a HEIC still', async () => {
    const file = await write('a.heic', heicWithExif(appleTiff({ contentId: ID })));
    expect(await readLiveContentId(file, 'still', signal)).toBe(ID);
  });

  it.each<[string, QuickTimeClipSpec]>([
    ['a QuickTime-style meta box in moov', { contentId: ID }],
    ['an ISO-style meta box in moov', { contentId: ID, metaStyle: 'iso' }],
    ['a top-level meta box', { contentId: ID, container: 'top-level' }],
  ])('reads the identifier of a clip with %s', async (name, spec) => {
    const file = await write(`clip-${name.length}.mov`, quickTimeClip(spec));
    expect(await readLiveContentId(file, 'clip', signal)).toBe(ID);
  });

  it('normalises the identifier to upper case', async () => {
    const lower = ID.toLowerCase();
    const still = await write('lower.jpg', jpegWithExif(appleTiff({ contentId: lower })));
    const clip = await write('lower.mov', quickTimeClip({ contentId: lower }));
    expect(await readLiveContentId(still, 'still', signal)).toBe(ID);
    expect(await readLiveContentId(clip, 'clip', signal)).toBe(ID);
  });

  it('is null for stills without an Apple identifier', async () => {
    const noExif = await write('no-exif.jpg', jpegWithExif(null));
    const noTag = await write('no-tag.jpg', jpegWithExif(appleTiff({ contentId: null })));
    const heicNoExif = await write('no-exif.heic', heicWithExif(null));
    const heicNoTag = await write('no-tag.heic', heicWithExif(appleTiff({ contentId: null })));
    expect(await readLiveContentId(noExif, 'still', signal)).toBeNull();
    expect(await readLiveContentId(noTag, 'still', signal)).toBeNull();
    expect(await readLiveContentId(heicNoExif, 'still', signal)).toBeNull();
    expect(await readLiveContentId(heicNoTag, 'still', signal)).toBeNull();
  });

  it('is null for a clip that is just a video, or keys a different identifier', async () => {
    const plain = await write('plain.mov', quickTimeClip({ contentId: null }));
    const other = await write(
      'other.mov',
      quickTimeClip({ contentId: ID, key: 'com.apple.quicktime.location.ISO6709' }),
    );
    expect(await readLiveContentId(plain, 'clip', signal)).toBeNull();
    expect(await readLiveContentId(other, 'clip', signal)).toBeNull();
  });

  it('is null for an identifier that is not a plausible token', async () => {
    const short = await write('short.jpg', jpegWithExif(appleTiff({ contentId: 'ab' })));
    const spaced = await write(
      'spaced.mov',
      quickTimeClip({ contentId: 'not a content id at all' }),
    );
    expect(await readLiveContentId(short, 'still', signal)).toBeNull();
    expect(await readLiveContentId(spaced, 'clip', signal)).toBeNull();
  });

  it('is null for files that are neither JPEG, HEIF nor QuickTime', async () => {
    const empty = await write('empty.jpg', Buffer.alloc(0));
    const junk = await write('junk.heic', Buffer.alloc(512, 0x41));
    expect(await readLiveContentId(empty, 'still', signal)).toBeNull();
    expect(await readLiveContentId(junk, 'still', signal)).toBeNull();
    expect(await readLiveContentId(junk, 'clip', signal)).toBeNull();
  });

  it('propagates a file that disappears', async () => {
    await expect(readLiveContentId(path.join(dir, 'gone.jpg'), 'still', signal)).rejects.toThrow();
  });
});
