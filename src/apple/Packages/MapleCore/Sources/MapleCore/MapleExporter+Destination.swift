import Foundation

extension MapleExporter {
  /// The chosen-file publication boundary used by the macOS Save Panel (#4102).
  /// Validate before rendering, then recheck after the render suspension before
  /// publishing. Source photos and aliases are never export destinations.
  @MainActor
  static func exportToFile(session: EditSession, options: ExportOptions, destination: URL)
    async throws
  {
    let asset = session.asset
    let original = asset.primaryURL
    let sourceScope = asset.scopeParentURL ?? original
    let reading = sourceScope?.startAccessingSecurityScopedResource() ?? false
    let writing = destination.startAccessingSecurityScopedResource()
    defer {
      if reading { sourceScope?.stopAccessingSecurityScopedResource() }
      if writing { destination.stopAccessingSecurityScopedResource() }
    }
    let source = try await BlockingWork.run {
      // Keep a selected source alias tied to its original target across render.
      let resolved = original?.resolvingSymlinksInPath().standardizedFileURL
      try validateExportDestination(destination, original: resolved)
      return resolved
    }
    let data = try await exportData(session: session, options: options)
    try await BlockingWork.run {
      try writeExportData(data, destination: destination, original: source)
    }
  }

  /// Recheck the selected source immediately before atomic publication.
  static func writeExportData(_ data: Data, destination: URL, original: URL?) throws {
    try validateExportDestination(destination, original: original)
    try data.write(to: destination, options: .atomic)
  }

  static func validateExportDestination(_ destination: URL, original: URL?) throws {
    guard destination.isFileURL else { throw CocoaError(.fileWriteUnsupportedScheme) }
    guard let original, original.isFileURL else { return }
    let sourcePath = original.resolvingSymlinksInPath().standardizedFileURL.path
    let destinationPath = destination.resolvingSymlinksInPath().standardizedFileURL.path
    guard sourcePath != destinationPath else { throw ExportError.originalDestination }
    let sourceAttributes = try FileManager.default.attributesOfItem(atPath: sourcePath)
    let destinationAttributes: [FileAttributeKey: Any]
    do {
      destinationAttributes = try FileManager.default.attributesOfItem(atPath: destinationPath)
    } catch let error as CocoaError
      where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile
    {
      // A new destination, including one under a symlinked parent, is valid.
      return
    }
    // Volume + inode identifies hard links and case aliases independently of
    // spelling. Read fresh attributes for both preflight and publication.
    guard let sourceVolume = sourceAttributes[.systemNumber] as? NSNumber,
      let sourceFile = sourceAttributes[.systemFileNumber] as? NSNumber,
      let destinationVolume = destinationAttributes[.systemNumber] as? NSNumber,
      let destinationFile = destinationAttributes[.systemFileNumber] as? NSNumber
    else { throw CocoaError(.fileReadUnknown) }
    guard sourceVolume != destinationVolume || sourceFile != destinationFile else {
      throw ExportError.originalDestination
    }
  }
}
