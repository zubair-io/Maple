import Foundation

extension RenderActor {
  /// The optional decoder cannot carry its failure through the FFI. Diagnose
  /// accepted companions only after a failed render, off the main actor;
  /// never turn a missing or damaged edit into an original-only preview.
  func removalRenderFailure(_ failure: Error, asset: AssetRef, model: AdjustmentModel) -> Error {
    guard let records = model.inpaintRemovals, !records.isEmpty,
      let rawURL = asset.primaryURL
    else { return failure }
    let scope = asset.scopeParentURL ?? rawURL.deletingLastPathComponent()
    let accessing = scope.startAccessingSecurityScopedResource()
    defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
    do {
      _ = try LocalRemovalAssetStore.readAssets(
        records: records.json,
        directory: rawURL.deletingLastPathComponent().appendingPathComponent(".maple/inpaint"))
      return failure
    } catch {
      return error
    }
  }
}
