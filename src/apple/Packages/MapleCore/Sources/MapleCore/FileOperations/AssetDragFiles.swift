import Foundation

/// Copies original bytes for a promised drag file, away from the UI actor.
public actor AssetDragFiles {
  public static let shared = AssetDragFiles()

  public static func fileName(for asset: AssetRef) -> String {
    let name =
      asset.primaryURL?.lastPathComponent ?? photoKitLocalID(of: asset).flatMap(
        PhotoKitOriginalFile.fileName(localID:)) ?? asset.displayName
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
      try publish(to: destination) { try FileManager.default.copyItem(at: source, to: $0) }
      return
    }
    let photoKitID = Self.photoKitLocalID(of: asset)
    let photoKitWriter: AssetRef.OriginalFileWriter? = photoKitID.map { localID in
      { try await PhotoKitOriginalFile.write(localID: localID, to: $0) }
    }
    guard let writer = asset.originalFileWriter ?? photoKitWriter else {
      throw ImageSourceError.notFound(asset.displayName)
    }
    let staging = FileManager.default.temporaryDirectory.appendingPathComponent(
      ".maple-drag-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: staging) }
    let temporary = staging.appendingPathComponent(Self.fileName(for: asset))
    try await writer(temporary)
    try Task.checkCancellation()
    try publish(to: destination) { try FileManager.default.moveItem(at: temporary, to: $0) }
  }

  /// A Photos Library tile's `stableID` is its `PHAsset.localIdentifier`.
  private static func photoKitLocalID(of asset: AssetRef) -> String? {
    asset.thumbnailProvenance == .photoKit && asset.primaryURL == nil ? asset.stableID : nil
  }

  /// File-promise destinations can be presented by iCloud / File Provider.
  /// Finish coordination before the provider reports promise completion.
  private func publish(to destination: URL, write: (URL) throws -> Void) throws {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var error: NSError?
    var result: Result<Void, Error>?
    coordinator.coordinate(writingItemAt: destination, options: [], error: &error) { url in
      result = Result { try write(url) }
    }
    if let error { throw error }
    guard let result else { throw CocoaError(.fileWriteUnknown) }
    try result.get()
  }
}
