import type { Asset, AssetId } from '../models/asset';
import type { PreviewSourceIdentity } from '../maple-cache/maple-cache.service';
import { imageDataToBitmap, PREVIEW_LONG_EDGE_PX } from '../raw-pipeline/image-utils';
import type { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { HostedByteSnapshot } from './hosted-byte-snapshot-cache';
import type { HostedPreviewResolver } from './hosted-preview-resolver.service';
import { isSupportedRaw } from './raw-extensions';

interface HostedThumbDeps {
  readonly preview: Pick<HostedPreviewResolver, 'resolve'>;
  readonly pipeline: Pick<RawPipelineService, 'decode'>;
  readonly getBytes: (id: AssetId) => Promise<Uint8Array>;
  readonly getSourceIdentity: (id: AssetId) => Promise<PreviewSourceIdentity>;
  readonly getSourceSnapshot: (id: AssetId) => Promise<HostedByteSnapshot>;
}

/** Decode a Hosted cache miss into thumbnail pixels without writing cache state. */
export async function decodeHostedThumb(
  asset: Asset,
  deps: HostedThumbDeps,
): Promise<ImageBitmap | null> {
  const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
  if (isSupportedRaw(asset.filename)) {
    const preview = await deps.preview.resolve(
      asset.id,
      deps.getBytes,
      deps.getSourceIdentity,
      deps.getSourceSnapshot,
    );
    if (preview) return createImageBitmap(preview);
    // A resolver miss is soft when the sensor format is decodable. X3F is the
    // one exception: full Foveon decode is intentionally unsupported (#417).
    if (ext === 'x3f') return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.getBytes(asset.id);
  } catch {
    return null;
  }
  // Thumbnail-sized decode (#2661): cap at the preview tier and use the
  // half-res Preview demosaic — the unsized call this replaces developed the
  // FULL sensor on the CPU, which for a 100 MP asset was a multi-GB develop
  // that OOM-aborted the wasm instance just to paint a grid tile.
  return imageDataToBitmap(
    await deps.pipeline.decode(bytes, ext, undefined, PREVIEW_LONG_EDGE_PX, true),
  );
}
