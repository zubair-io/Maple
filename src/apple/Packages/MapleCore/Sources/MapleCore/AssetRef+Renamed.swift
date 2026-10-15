import Foundation

extension AssetRef {
  /// Bind original delivery to the rename engine's confirmed share-relative
  /// path, including when its caller supplied a legacy ID-only reference.
  public func renamedSMB(to filename: String, at path: String, source: SMBSource) throws -> AssetRef
  {
    guard let stableID, let bytesProvider else { throw ImageSourceError.notFound(displayName) }
    let ext = (filename as NSString).pathExtension.lowercased()
    let ref = ImageRef(id: stableID, displayName: filename, smbPath: path)
    return AssetRef(
      displayName: filename, hintExtension: ext.isEmpty ? nil : ext,
      stableID: stableID, captureDate: captureDate, explicitIsRaw: explicitIsRaw,
      thumbnailProvenance: thumbnailProvenance, displayPreviewProvider: displayPreviewProvider,
      originalFileWriter: { try await source.writeOriginal(for: ref, to: $0) },
      bytesProvider: bytesProvider)
  }

  /// Cloud original delivery is addressed by path. Rebind it to the
  /// rename response's new path instead of retaining the old closure.
  public func renamedCloud(to filename: String, at path: String, source: CloudSource) throws
    -> AssetRef
  {
    guard let catalog, let bytesProvider else { throw ImageSourceError.notFound(displayName) }
    let ext = (filename as NSString).pathExtension.lowercased()
    let ref = ImageRef(id: "fs:\(path)", displayName: filename)
    return AssetRef(
      displayName: filename, hintExtension: ext.isEmpty ? nil : ext,
      stableID: stableID, captureDate: captureDate, explicitIsRaw: explicitIsRaw,
      thumbnailProvenance: thumbnailProvenance, displayPreviewProvider: displayPreviewProvider,
      // Enrichment resolves a fresh address through its existing by-fspath fallback.
      catalog: CatalogRef(
        serverID: catalog.serverID, folderID: catalog.folderID, absPath: path, address: nil),
      originalFileWriter: { try await source.writeOriginal(for: ref, to: $0) },
      bytesProvider: bytesProvider)
  }
}
