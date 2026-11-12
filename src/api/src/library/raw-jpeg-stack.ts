import * as path from 'node:path';
import { RAW_EXTENSIONS } from '../indexer/media-types.ts';

const JPEG_EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'jpeg']);

function extensionOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

/** The sidecar stem the two files share (`IMG_1.CR3` and `IMG_1.JPG` both read `IMG_1.xmp`). */
function stackStem(filename: string): string {
  return path.parse(filename).name.normalize('NFC').toLowerCase();
}

/**
 * The RAW+JPEG pairs among one folder's file names: a stem that holds exactly
 * one RAW and exactly one JPEG. Any other group (two JPEGs, two RAWs) is
 * ambiguous and leaves every member independent. The key is the RAW's name.
 */
export function pairRawJpegStacks(filenames: readonly string[]): ReadonlyMap<string, string> {
  const groups = Map.groupBy(filenames, stackStem);
  return new Map(
    [...groups.values()].flatMap((members) => {
      const raws = members.filter((name) => RAW_EXTENSIONS.has(extensionOf(name)));
      const jpegs = members.filter((name) => JPEG_EXTENSIONS.has(extensionOf(name)));
      const [raw, jpeg] = [raws[0], jpegs[0]];
      return raws.length === 1 && jpegs.length === 1 && raw && jpeg
        ? [[raw, jpeg] as [string, string]]
        : [];
    }),
  );
}
