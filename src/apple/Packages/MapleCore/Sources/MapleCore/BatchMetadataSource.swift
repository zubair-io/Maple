import Foundation

/// Rejects a stale file-backed selection before batch metadata creates its sidecar.
enum BatchMetadataSource {
  static func requireAvailable(_ asset: AssetRef) throws {
    guard let url = asset.primaryURL else { return }
    let scope = asset.scopeParentURL ?? url
    let accessing = scope.startAccessingSecurityScopedResource()
    defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw CocoaError(.fileNoSuchFile)
    }
  }
}
