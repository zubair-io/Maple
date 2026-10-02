import CoreImage
import Foundation

extension RenderActor {
  /// A fresh immutable model snapshot; originals and accepted assets are read
  /// only. Saved companions resolve beside the actual/staged original.
  func renderFullRawExport(
    asset: AssetRef, model: AdjustmentModel, quality: PipelineRenderer.Quality,
    target: CanvasColorSpace, filmLut: (data: [Float], size: Int, key: UInt32)?
  ) async throws -> CIImage {
    let raw = try await rawRenderSource.url(for: asset)
    let scope = asset.scopeParentURL ?? raw.deletingLastPathComponent()
    let accessing = scope.startAccessingSecurityScopedResource()
    defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
    let snapshot = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-full-export-\(UUID().uuidString).xmp")
    let xml = XMPSerializer.serialize(model: model, culling: CullingState())
    try xml.write(to: snapshot, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: snapshot) }
    try Task.checkCancellation()
    let image = try PipelineRenderer.renderFullDisplay(
      rawPath: raw, xmpPath: snapshot, quality: quality, target: target, filmLut: filmLut)
    try Task.checkCancellation()
    return image
  }
}
