/**
 * The preview the `thumb` stage writes beside an edited RAW's thumbnail
 * (#6034). Developing an edited RAW reads and decodes the whole file, and the
 * `preview` stage would do both again for its own size, so the thumb render
 * offers the same decode a second output.
 *
 * It is only a head start for the `preview` stage, which keeps its freshness
 * check and its bookkeeping: a file published here is one that stage finds
 * fresh, and anything else it renders itself. So the offer is made only while
 * that stage would be rendering — started, not paused, and not holding back
 * for an on-demand request — and nothing here can fail the thumbnail.
 */

import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { mkdir, replicatePath, stat } from '../../fs/mirrored.ts';
import { assertDerivativeCacheDirectory } from '../../indexer/derivative-cache.ts';
import {
  isPreviewCacheFresh,
  PREVIEW_AVIF_QUALITY,
  PREVIEW_CACHE_SUFFIX,
  PREVIEW_LONG_EDGE_PX,
} from '../../indexer/previewer.ts';
import { finalizeAvifRender } from '../../thumbs/validate-avif.ts';
import type { CompanionDerivative } from '../../thumbs/raw-sidecar-render.ts';
import { child as childLogger } from '../../log.ts';
import { backgroundPreviewsYielding } from '../background-preview-gate.ts';
import { stageRegistry } from '../registry.ts';
import type { StageName } from './stage-names.ts';

const log = childLogger('workers:preview-companion');

const PREVIEW_STAGE: StageName = 'preview';

type Asset = Parameters<typeof cachePathForAsset>[0];
type LibraryRoots = Parameters<typeof cachePathForAsset>[1];
type CompanionOffer = () => Promise<CompanionDerivative | null>;

function previewStageRendering(): boolean {
  return stageRegistry.isAccepting(PREVIEW_STAGE) && !backgroundPreviewsYielding();
}

/** Publish the render's preview, or discard it when the thumbnail failed or
 * the `preview` stage was paused while it rendered. */
async function settle(
  tmpPath: string,
  previewPath: string,
  absPath: string,
  thumbRendered: boolean,
): Promise<void> {
  try {
    if (!(await stat(tmpPath).catch(() => null))) return;
    const published = await finalizeAvifRender(
      thumbRendered && stageRegistry.isAccepting(PREVIEW_STAGE),
      tmpPath,
      previewPath,
      PREVIEW_LONG_EDGE_PX,
      log,
      { assetPath: absPath, tier: 'preview' },
    );
    if (published) replicatePath(previewPath);
  } catch (error) {
    log.warn(
      { absPath, err: error instanceof Error ? error.message : error },
      'co-produced preview was not published',
    );
  }
}

/**
 * Run a thumbnail render for the `thumb` stage, offering it the asset's
 * preview as a second output. Resolves or rejects exactly as `render` does.
 */
export async function renderThumbWithPreview(
  asset: Asset,
  libraries: LibraryRoots,
  absPath: string,
  render: (companion?: CompanionOffer) => Promise<boolean>,
): Promise<boolean> {
  const previewPath = previewStageRendering()
    ? cachePathForAsset(asset, libraries, 'previews', PREVIEW_CACHE_SUFFIX)
    : null;
  if (!previewPath) return render();

  const tmpPath = `${previewPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  let offered = false;
  const offer: CompanionOffer = async () => {
    if (!previewStageRendering()) return null;
    await assertDerivativeCacheDirectory(previewPath);
    await mkdir(dirname(previewPath), { recursive: true });
    if (await isPreviewCacheFresh(previewPath, absPath)) return null;
    offered = true;
    return { outPath: tmpPath, maxPx: PREVIEW_LONG_EDGE_PX, quality: PREVIEW_AVIF_QUALITY };
  };
  const finish = (thumbRendered: boolean): Promise<void> =>
    offered ? settle(tmpPath, previewPath, absPath, thumbRendered) : Promise.resolve();

  const rendered = await render(offer).catch(async (error: unknown) => {
    await finish(false);
    throw error;
  });
  await finish(rendered);
  return rendered;
}
