// RenderActor+Export.swift — full-resolution export render (slice 2).
//
// Full-quality decode and develop of an immutable export model. The session
// applies crop and optional non-RAW film before MapleExporter encodes it.
//
// Export is the one render path that genuinely wants a full-sensor decode —
// every interactive path decodes to a bounded display target (#785/#1637/
// #2058), so `renderForExport` is the sole remaining caller of the unsized
// `decodeSceneLinear` with the AMaZE flag gate (#940).

import CoreImage
import Foundation

extension RenderActor {
  // MARK: - Export (slice 2)

  public func renderForExport(
    asset: AssetRef,
    model: AdjustmentModel,
    asShot: ImageEditPipeline.AsShotWB?,
    // #3190 review follow-up: `EditSession.renderForExport()` composites
    // an sRGB-baked `FilmLookCube` on this function's NON-RAW result
    // when the asset has a resolvable look — the caller passes `.srgb`
    // in that case so the encode doesn't hand the cube P3-gamma bytes.
    // The RAW branch below never needs this: a RAW export with a
    // resolved look takes the bit-exact `maple_render_file_with_film`
    // path instead and never reaches here (see
    // `EditSession.renderForExport()`'s doc comment), so film is
    // guaranteed inactive whenever the RAW branch runs.
    targetPrimariesOverride: CanvasColorSpace? = nil
  ) async throws -> CIImage {
    let pipeline = self.pipeline
    let m = model

    if !asset.isRaw {
      guard
        let decoded = await pipeline.decodeSceneLinearNonRaw(
          asset: asset, targetSize: nil
        )
      else {
        throw RenderError.pipelineFailed
      }
      return await Task.detached(priority: .userInitiated) {
        pipeline.processSceneLinearNonRaw(
          decoded: decoded, model: m, targetSize: nil,
          targetPrimariesOverride: targetPrimariesOverride
        )
      }.value
    }

    // Export uses one immutable snapshot of the live edits, including
    // decode-baked fields. A remote or not-yet-saved sidecar must not
    // silently select defaults (#3357).
    let sidecar = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-export-\(UUID().uuidString).xmp")
    let xml = XMPSerializer.serialize(model: m, culling: CullingState())
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: sidecar) }
    let quality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
    guard
      let exportDecodeResult = await pipeline.decodeSceneLinear(
        asset: asset, quality: quality, xmpPath: sidecar,
        profileOverride: asset.isRaw ? m.profile : nil,
        autoExposureOverride: asset.isRaw ? m.autoExposure : nil
      )
    else {
      throw RenderError.pipelineFailed
    }
    let profileLUT: CIFilter?
    if m.profile == .auto {
      let url = try await rawRenderSource.url(for: asset)
      let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      profileLUT = await AutoProfileLUT.shared.filter(
        forRawAt: url, profile: m.profile, quality: quality)
    } else {
      profileLUT = nil
    }
    let exportNoiseProfile = exportDecodeResult.noiseProfile
    let exportISO = exportDecodeResult.iso
    let exportWbFrame = exportDecodeResult.wbFrame
    let exportAnchor =
      exportWbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
        guard frame.isPresent else { return nil }
        return .init(temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
      } ?? asShot
    return await Task.detached(priority: .userInitiated) {
      pipeline.processSceneLinear(
        decoded: exportDecodeResult.image,
        model: m,
        targetSize: nil,
        asShot: exportAnchor,
        decodedAtModel: m,
        profileLUT: profileLUT,
        noiseProfile: exportNoiseProfile,
        iso: exportISO,
        wbFrame: exportWbFrame
      )
    }.value
  }

  /// Full decode→develop→render of a RAW+XMP with a film-look lattice
  /// blended in (epic #2683, Task 10 / bugfix round 2). Wraps
  /// `PipelineRenderer.render(rawPath:xmpPath:quality:filmLut:)` —
  /// `maple_render_file_with_film` under the FFI — the same heavy,
  /// CPU-bound call the plain `renderForExport` above keeps off the main
  /// actor via `Task.detached`. This entry doesn't need the extra
  /// `Task.detached` hop: `PipelineRenderer` is a stateless `Sendable`
  /// struct around the FFI, and `RenderActor` is already a dedicated
  /// actor distinct from `@MainActor` — running the call directly inside
  /// this method keeps it off the main actor without adding a second
  /// concurrency domain to reason about.
  ///
  /// `EditSession.renderExportWithFilmLook()` keeps the `@MainActor`-side
  /// responsibilities (the applicability guard, flushing the pending
  /// sidecar write, resolving the lattice from `filmLutStore`) and awaits
  /// this method for the heavy render only.
  public func renderExportWithFilmLook(
    rawPath: URL,
    xmpPath: URL?,
    quality: PipelineRenderer.Quality,
    filmLut: (data: [Float], size: Int, key: UInt32)?
  ) throws -> MapleImageData {
    try PipelineRenderer.render(
      rawPath: rawPath,
      xmpPath: xmpPath,
      quality: quality,
      filmLut: filmLut
    )
  }
}
