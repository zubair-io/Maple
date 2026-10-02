import { extname } from 'node:path';

type CacheFormatMatcher = (bytes: Buffer) => boolean;
const asciiAt = (bytes: Buffer, offset: number, expected: string): boolean =>
  bytes.subarray(offset, offset + expected.length).toString('ascii') === expected;
const CACHE_FORMAT_MATCHERS: Readonly<Record<string, CacheFormatMatcher>> = {
  '.jpg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8,
  '.png': (bytes) =>
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.webp': (bytes) => asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP'),
  '.avif': (bytes) =>
    bytes.length >= 12 &&
    asciiAt(bytes, 4, 'ftyp') &&
    ['avif', 'avis'].some((brand) => bytes.subarray(8).toString('ascii').includes(brand)),
};
export function cacheFormatMatches(path: string, bytes: Buffer): boolean {
  return CACHE_FORMAT_MATCHERS[extname(path)]?.(bytes) ?? false;
}
