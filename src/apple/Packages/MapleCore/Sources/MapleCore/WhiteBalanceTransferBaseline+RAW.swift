import Foundation
import RawPipeline

extension WhiteBalanceTransferBaseline {
  static func cameraBaseline(temperature: Double, tint: Double) -> Self {
    Self(temperature: (temperature / 50).rounded() * 50, tint: tint.rounded())
  }

  /// Read the camera baseline through the shared Rust estimator. Remote RAWs
  /// are staged privately and removed after analysis; no source sidecar is read
  /// or written and no edited temperature is mistaken for camera metadata.
  public static func read(asset: AssetRef) async throws -> Self {
    guard asset.isRaw else { throw AdjustmentTransferError.missingBaseline }
    let work = Task.detached(priority: .userInitiated) {
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-wb-baseline-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let scope = asset.scopeParentURL ?? asset.primaryURL
      let accessing = scope?.startAccessingSecurityScopedResource() ?? false
      defer { if accessing { scope?.stopAccessingSecurityScopedResource() } }
      let rawURL: URL
      if let url = asset.primaryURL {
        rawURL = url
      } else if let provider = asset.bytesProvider {
        let bytes = try await provider()
        try Task.checkCancellation()
        rawURL = directory.appendingPathComponent("original")
          .appendingPathExtension(asset.hintExtension ?? "dng")
        try bytes.write(to: rawURL)
      } else {
        throw AdjustmentTransferError.missingBaseline
      }
      try Task.checkCancellation()
      var pair: [Float] = [0, 0]
      let code = rawURL.path.withCString { path in
        pair.withUnsafeMutableBufferPointer { output in
          maple_as_shot_white_balance_file(path, output.baseAddress)
        }
      }
      guard code == 0, pair[0].isFinite, pair[0] > 0, pair[1].isFinite else {
        throw AdjustmentTransferError.missingBaseline
      }
      return Self.cameraBaseline(temperature: Double(pair[0]), tint: Double(pair[1]))
    }
    return try await withTaskCancellationHandler {
      try await work.value
    } onCancel: {
      work.cancel()
    }
  }
}
