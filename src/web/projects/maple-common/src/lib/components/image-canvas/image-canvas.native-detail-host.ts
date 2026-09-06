import type { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasNativeDetail } from './image-canvas.native-detail';
import { isNonRawExtension } from '../../state/raw-extensions';
import { isIdentityCrop, type AdjustmentModel } from '../../models/adjustment-model';
import { displayDims } from './image-canvas.crop';

/** A sized bitmap preserves aspect, but 100% zoom needs the source extent. */
export function canvasDisplayDims(host: ImageCanvasComponent) {
  const asset = host.state.focusedAsset();
  const native = host.canvasSvc.nativeDimensions();
  if (native && asset && isIdentityCrop(host.state.adjustmentFor(asset.id)().crop)) return native;
  return displayDims(host.canvasSvc.paintedAspect(), asset?.width, asset?.height);
}

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
      const model = host.state.adjustmentFor(asset.id)();
      if (
        !isIdentityCrop(model.crop) ||
        manualGeometryActive(model) ||
        importedCorrectionsActive(model)
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

function manualGeometryActive(model: AdjustmentModel): boolean {
  return (
    model.geoPerspectiveH !== 0 ||
    model.geoPerspectiveV !== 0 ||
    model.geoRotation !== 0 ||
    model.geoAspect !== 1 ||
    model.geoScale !== 1
  );
}

function importedCorrectionsActive(model: AdjustmentModel): boolean {
  return (
    model.lensProfileEnable === 'On' &&
    !!model.lensProfile &&
    (model.lensCorrectionDistortion > 0 ||
      model.lensCorrectionCa > 0 ||
      model.lensCorrectionVignetting > 0)
  );
}
