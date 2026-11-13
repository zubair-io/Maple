import { computed, type Signal } from '@angular/core';
import type { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasNativeDetail } from './image-canvas.native-detail';
import { isNonRawExtension } from '../../state/raw-extensions';
import { isIdentityCrop } from '../../models/adjustment-model';
import { resolveCanvasImageExtent } from './image-canvas.crop';

type Extent = { w: number; h: number };

/** The extent the zoom model and the draw share (`resolveCanvasImageExtent`). */
export function canvasImageExtent(host: ImageCanvasComponent): Extent | null {
  const asset = host.state.focusedAsset();
  return resolveCanvasImageExtent({
    painted: host.canvasSvc.paintedAspect(),
    native: host.canvasSvc.nativeDimensions(),
    assetW: asset?.width,
    assetH: asset?.height,
    crop: asset ? host.state.adjustmentFor(asset.id)().crop : undefined,
    cropToolActive: host.cropSession.active(),
  });
}

/** The extent as a signal that only fires when the size really changes. */
export function createImageExtent(host: ImageCanvasComponent): Signal<Extent | null> {
  return computed(() => canvasImageExtent(host), {
    equal: (a, b) => a?.w === b?.w && a?.h === b?.h,
  });
}

/** The component owns signals; the patch controller owns retained resources. */
export function createNativeDetail(
  host: ImageCanvasComponent,
  disabled: () => boolean,
): ImageCanvasNativeDetail {
  return new ImageCanvasNativeDetail({
    pipeline: host.pipeline,
    loadRemovals: (assetId, xmp) => host.savedRemovals.load(assetId, xmp),
    currentInput: () => {
      const asset = host.state.focusedAsset();
      return asset && asset.id === host.currentAssetId && host.currentBytes
        ? {
            assetId: asset.id,
            bytes: host.currentBytes,
            ext: host.currentExt,
            generation: host.renderGeneration,
            xmp: host.serializeForRender(host.state.adjustmentFor(asset.id)()),
          }
        : null;
    },
    detailView: () => {
      const asset = host.state.focusedAsset();
      const dims = host.canvasSvc.nativeDimensions();
      if (
        disabled() ||
        !asset ||
        !dims ||
        isNonRawExtension(host.currentExt) ||
        host.canvasSvc.beforeAfterSplitX() !== null ||
        host.canvasSvc.pixelScale() < 1
      )
        return null;
      if (!isIdentityCrop(host.state.adjustmentFor(asset.id)().crop)) return null;
      return {
        nativeW: dims.w,
        nativeH: dims.h,
        wrapW: host.wrapW(),
        wrapH: host.wrapH(),
        ...host.currentLayout(),
      };
    },
  });
}
