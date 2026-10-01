import CoreImage
import Foundation

extension ThumbnailLoader {
  /// A missing sidecar keeps the embedded-preview path available. A present
  /// sidecar must validate and develop; errors never fall through to camera
  /// pixels. Runs inside the caller's detached decode-slot task (#3973).
  static func renderRawSidecarDerivative(
    at rawURL: URL, targetLongEdge: CGFloat, quality: CGFloat,
    filmBundle: Bundle = .main
  ) throws -> Data? {
    let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
    let xml: Data
    do {
      xml = try Data(contentsOf: sidecarURL)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return nil
    }
    let (model, _) = try XMPParser.parse(data: xml)
    // Native parsing reads a path. Own the validated snapshot so an
    // overlapping autosave cannot replace it with an unchecked document.
    let snapshot = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-raw-derivative-\(UUID().uuidString).xmp")
    defer { try? FileManager.default.removeItem(at: snapshot) }
    try xml.write(to: snapshot, options: .atomic)
    // Resolve per task: FilmLutStore's one-entry cache is mutable and must
    // not be shared between concurrent thumbnail decodes.
    let film = FilmLutStore(bundle: filmBundle).lattice(for: model.filmLook)
    let image = try PipelineRenderer.render(
      rawPath: rawURL, xmpPath: snapshot, quality: .preview, filmLut: film)
    guard
      let data = encodeThumbnail(
        image, ctx: rawSidecarEncodeContext, targetLongEdge: targetLongEdge, quality: quality
      )
    else { throw RawSidecarDerivativeError.encodeFailed }
    return data
  }

  private static let rawSidecarEncodeContext = CIContext()

  /// Downscale the pipeline-produced RGB buffer to the thumbnail long-edge
  /// and AVIF-encode at `ThumbnailEncoder.quality`.
  /// `targetLongEdge`/`quality` default to the local-grid contract (256px
  /// / `ThumbnailEncoder.quality`). The render-from-bytes fallback also
  /// calls this with the on-share contract's parameters
  /// (`MapleThumbCacheKey.onShareThumbLongEdgePx`/`onShareThumbAVIFQuality`,
  /// #2690) to produce a SEPARATE write-back candidate from the same
  /// already-decoded `image` — one RAW decode, two encodes, no second FFI
  /// call.
  static func encodeThumbnail(
    _ image: MapleImageData, ctx: CIContext,
    targetLongEdge: CGFloat = ThumbnailDiskCache.defaultThumbSize.width,
    quality: CGFloat = ThumbnailEncoder.quality
  ) -> Data? {
    guard image.pixels.count == image.width * image.height * 3 else { return nil }

    let bitmapInfo = CGImageAlphaInfo.none.rawValue
    let copy = image.pixels
    guard let dp = CGDataProvider(data: copy as CFData) else { return nil }
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    guard
      let cgImg = CGImage(
        width: image.width, height: image.height,
        bitsPerComponent: 8, bitsPerPixel: 24,
        bytesPerRow: image.width * 3,
        space: colorSpace,
        bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
        provider: dp,
        decode: nil,
        shouldInterpolate: true,
        intent: .defaultIntent
      )
    else { return nil }

    var ci = CIImage(cgImage: cgImg)
    let longEdge = CGFloat(max(image.width, image.height))
    if longEdge > targetLongEdge {
      let scale = targetLongEdge / longEdge
      ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }

    return ThumbnailEncoder.encode(ci, ctx: ctx, quality: quality)
  }

}

private enum RawSidecarDerivativeError: Error {
  case encodeFailed
}
