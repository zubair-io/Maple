import type { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasNativeDetail } from './image-canvas.native-detail';
import { isNonRawExtension } from '../../state/raw-extensions';

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
      const crop = host.state.adjustmentFor(asset.id)().crop;
      if (
        crop.left !== 0 ||
        crop.top !== 0 ||
        crop.right !== 1 ||
        crop.bottom !== 1 ||
        crop.angle !== 0
      )
        return null;
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
