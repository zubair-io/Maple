import CoreImage
import Foundation

extension ThumbnailLoader {
  /// Rebuild a local bitmap derivative from a canonical XMP snapshot using
  /// the same non-RAW color chain, film look and crop as the editor export.
  /// A changed sidecar must never fall back to camera-original pixels.
  static func renderNonRawSidecarDerivative(
    at url: URL, targetLongEdge: CGFloat, quality: CGFloat,
    filmBundle: Bundle = .main
  ) async throws -> Data? {
    let sidecar = SidecarPath.sidecarURL(for: url)
    let xml: Data
    do {
      xml = try Data(contentsOf: sidecar)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return nil
    }
    let (parsedModel, _) = try XMPParser.parse(data: xml)
    // Rating/flag saves seed as-shot WB without authoring a visual edit.
    // Preserve the camera fast path for those sidecars; a WB-only external
    // edit remains ambiguous until the XMP records an explicit edit intent.
    guard parsedModel.isVisuallyEditedBeyondWhiteBalance else { return nil }
    let maskSession = await EditSession(asset: AssetRef(url: url))
    let model = await maskSession.rehydratedMaskRasters(in: parsedModel)
    let rasterIDs = Set(model.localAdjustments.flatMap(\.mask.registeredRasterIds))
    defer { rasterIDs.forEach(MaskRasterRegistry.release) }
    guard
      model.localAdjustments.allSatisfy({ layer in
        layer.mask.bitmapMasks.allSatisfy { $0.rasterId != 0 }
          && layer.mask.brushMasks.allSatisfy { $0.rasterId != 0 }
      })
    else { throw RawSidecarDerivativeError.maskUnavailable }
    let crop = model.crop
    let fraction = min(crop.right - crop.left, crop.bottom - crop.top)
    let decodeEdge = min(4_096, targetLongEdge / CGFloat(max(fraction, 0.125)))
    let pipeline = ImageEditPipeline()
    guard
      let decoded = await pipeline.decodeSceneLinearNonRaw(
        asset: AssetRef(url: url),
        targetSize: CGSize(width: decodeEdge, height: decodeEdge))
    else { throw RawSidecarDerivativeError.decodeFailed }

    let lattice = FilmLutStore(bundle: filmBundle).lattice(for: model.filmLook)
    let filmActive = lattice != nil && model.filmStrength > 0
    let processed = pipeline.processSceneLinearNonRaw(
      decoded: decoded, model: model,
      targetPrimariesOverride: filmActive ? .srgb : nil)
    let developed = FilmLookCube.apply(
      to: processed, lattice: lattice, strengthPct: model.filmStrength)
    let cropped = CropImageStage.apply(crop, to: developed, nativeSize: decoded.extent.size)
    let edge = max(cropped.extent.width, cropped.extent.height)
    let scale = edge > targetLongEdge ? targetLongEdge / edge : 1
    let sized = cropped.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard
      let data = ThumbnailEncoder.encode(
        sized, ctx: rawSidecarEncodeContext, quality: quality)
    else { throw RawSidecarDerivativeError.encodeFailed }
    return data
  }

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
  case decodeFailed
  case encodeFailed
  case maskUnavailable
}
