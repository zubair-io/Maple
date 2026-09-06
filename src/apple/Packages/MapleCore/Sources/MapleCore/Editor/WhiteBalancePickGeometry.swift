import CoreGraphics
import Foundation

/// Inverts the canvas placement and the same canonical crop rectangle used by
/// `CropImageStage.apply`. The result addresses the uncropped, EXIF-oriented
/// image; the FFI then maps that point into its sensor-oriented probe.
public enum WhiteBalancePickGeometry {
  public static func imagePoint(
    at location: CGPoint, viewport: CGSize, displayFrame: CGSize,
    pan: CGSize, nativeSize: CGSize, crop: Crop
  ) -> CGPoint? {
    guard displayFrame.width > 0, displayFrame.height > 0,
      nativeSize.width > 0, nativeSize.height > 0
    else { return nil }
    let left = viewport.width / 2 + pan.width - displayFrame.width / 2
    let top = viewport.height / 2 + pan.height - displayFrame.height / 2
    let x = (location.x - left) / displayFrame.width
    let y = (location.y - top) / displayFrame.height
    guard contains(x, y) else { return nil }
    guard CropImageStage.shouldApply(crop),
      let rect = CropImageStage.cropRect(crop, bufferSize: nativeSize, nativeSize: nativeSize)
    else { return CGPoint(x: x, y: y) }

    // cropRect is y-up. Convert its top-left to canvas coordinates before
    // reversing the clockwise straighten about the full image's centre.
    let dx = rect.minX + x * rect.width - nativeSize.width / 2
    let dy = nativeSize.height - rect.maxY + y * rect.height - nativeSize.height / 2
    let angle = crop.angle * .pi / 180
    let nx = (dx * cos(angle) + dy * sin(angle)) / nativeSize.width + 0.5
    let ny = (-dx * sin(angle) + dy * cos(angle)) / nativeSize.height + 0.5
    // A rotated frame can expose empty corners inside the crop. Never
    // clamp those to a real edge pixel and silently sample the wrong area.
    guard contains(nx, ny) else { return nil }
    return CGPoint(x: nx, y: ny)
  }

  private static func contains(_ x: CGFloat, _ y: CGFloat) -> Bool {
    x.isFinite && y.isFinite && (0...1).contains(x) && (0...1).contains(y)
  }
}
