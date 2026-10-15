import Foundation

/// Copies original bytes for a promised drag file, away from the UI actor.
public actor AssetDragFiles {
  public static let shared = AssetDragFiles()

  public static func fileName(for asset: AssetRef) -> String {
    let name = asset.primaryURL?.lastPathComponent ?? asset.displayName
    let basename = (name as NSString).lastPathComponent
    let safeName =
      basename.isEmpty || basename == "." || basename == ".." ? asset.id.uuidString : basename
    guard (safeName as NSString).pathExtension.isEmpty,
      let ext = asset.hintExtension, !ext.isEmpty,
      ext.allSatisfy({ $0.isLetter || $0.isNumber })
    else { return safeName }
    return "\(safeName).\(ext)"
  }

  /// Never moves, renders, or overwrites an original (or an existing destination).
  public func writeOriginal(_ asset: AssetRef, to destination: URL) async throws {
    if let source = asset.primaryURL, source.isFileURL {
      let scope = asset.scopeParentURL ?? source
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      try FileManager.default.copyItem(at: source, to: destination)
      return
    }
    guard let provider = asset.bytesProvider else {
      throw ImageSourceError.notFound(asset.displayName)
    }
    let bytes = try await provider()
    try Task.checkCancellation()
    try bytes.write(to: destination, options: .withoutOverwriting)
  }
}
