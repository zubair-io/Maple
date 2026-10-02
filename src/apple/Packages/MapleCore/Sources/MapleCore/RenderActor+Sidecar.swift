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

  /// Cold decode/cache validation. Invalid owned edits cannot compare equal
  /// to defaults; callers must refuse reuse or publication on failure (#3955).
  nonisolated static func validatedBakedModel(for asset: AssetRef) throws -> AdjustmentModel? {
    guard let url = asset.sidecarURL, FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }
    let model = try XMPParser.parse(data: Data(contentsOf: url)).0
    var baked = RawCoreBridge.stripAppleGPUStages(model)
    baked.profile = AdjustmentModel.default.profile
    baked.autoExposure = AdjustmentModel.default.autoExposure
    return baked
  }

  /// Optional inspector for seeding/tests. Production freshness and decode
  /// publication use the throwing variant so malformed is distinct from absent.
  nonisolated static func bakedModel(for asset: AssetRef) -> AdjustmentModel? {
    try? validatedBakedModel(for: asset)
  }

  /// Snapshot the exact decode-baked inputs once, outside the render loop.
  /// File RAW consumers resolve companions beside the original, independent
  /// of this temporary parameter file. Remote companion transport is #3955.
  nonisolated static func coldDecodeSidecar(_ model: AdjustmentModel?) throws -> URL? {
    guard let model else { return nil }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-decode-\(UUID().uuidString).xmp")
    let xml = XMPSerializer.serialize(
      model: model, culling: CullingState(), omitWhiteBalance: true)
    try xml.write(to: url, atomically: true, encoding: .utf8)
    return url
  }
}
