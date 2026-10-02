import CoreImage
import Foundation

extension EditSession {
  /// Full RAW film delivery uses the same float render as ordinary full export.
  /// Returns nil only when there is no applicable, resolved RAW film look.
  /// Render failures propagate, so a saved edit cannot become partial output.
  func renderExportWithFilmLook(quality: PipelineRenderer.Quality? = nil) async throws -> CIImage? {
    guard asset.isRaw, !model.filmLook.isEmpty,
      let lut = filmLutStore.lattice(for: model.filmLook)
    else { return nil }
    let snapshot = model
    return try await renderActor.renderForExport(
      asset: asset, model: snapshot, asShot: wbDeltaAnchor,
      qualityOverride: quality ?? (AmazeFlag.isEnabled ? .amaze : .full),
      targetPrimariesOverride: .srgb, filmLut: lut)
  }
}
