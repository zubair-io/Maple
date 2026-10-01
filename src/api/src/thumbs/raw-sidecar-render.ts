import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from '../fs/mirrored.ts';
import { SaxesParser } from 'saxes';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { renderImageThumbToFileViaPool } from './bitmap-pool.ts';

/** Cold-cache RAW regeneration. Null means no sidecar; a present sidecar
 * must develop successfully, with no fallthrough to camera-original pixels. */
export async function renderRawSidecarDerivative(
  rawPath: string,
  outPath: string,
  maxPx: number,
  quality: number,
): Promise<true | null> {
  const xmpPath = xmpSidecarPath(rawPath);
  const xml = await readFile(xmpPath, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (xml === null) return null;

  // The native adjustment parser tolerates incomplete XML. Validate the cold
  // read, then render that exact snapshot so a concurrent sidecar save cannot
  // swap an unchecked document into the develop call (#3971).
  new SaxesParser({ xmlns: true }).write(xml).close();
  const snapshotPath = `${outPath}.tmp.develop.${randomUUID()}`;
  const jpegPath = `${snapshotPath}.jpg`;
  const snapshotXmp = `${snapshotPath}.xmp`;
  try {
    await writeFile(snapshotXmp, xml);
    const developed = await ffiPool().renderDevelopJpegToFile(
      rawPath,
      snapshotXmp,
      jpegPath,
      maxPx,
      90,
    );
    if (!developed) throw new Error(`RAW sidecar develop failed: ${rawPath}`);
    const encoded = await renderImageThumbToFileViaPool(jpegPath, outPath, maxPx, quality, 'jpg');
    if (!encoded.ok) throw new Error(`RAW sidecar AVIF encode failed: ${encoded.error ?? rawPath}`);
    return true;
  } finally {
    await rm(jpegPath, { force: true });
    await rm(snapshotXmp, { force: true });
  }
}
