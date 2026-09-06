import type { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasNativeDetail } from './image-canvas.native-detail';
import { isNonRawExtension } from '../../state/raw-extensions';
import { isIdentityCrop } from '../../models/adjustment-model';

/** The component owns signals; the patch controller owns retained resources. */
export function createNativeDetail(
  host: ImageCanvasComponent,
  disabled: () => boolean,
): ImageCanvasNativeDetail {
  return new ImageCanvasNativeDetail({
    pipeline: host.pipeline,
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
