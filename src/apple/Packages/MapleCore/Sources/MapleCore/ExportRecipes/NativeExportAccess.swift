import Foundation

/// Scoped grants live for one actual run, including its suspended native bake.
final class NativeExportAccess: @unchecked Sendable {
  let sources: [String: URL]
  let destination: URL
  private let accessing: [URL]

  init(record: NativeExportRecord, workspace: URL? = nil) throws {
    var scopes: [String: URL] = [:]
    var granted: [URL] = []
    do {
      let destination = try Self.resolve(record.destinationBookmark)
      if destination.startAccessingSecurityScopedResource() { granted.append(destination) }
      self.destination = destination.resolvingSymlinksInPath().standardizedFileURL
      var sources: [String: URL] = [:]
      for source in record.originals {
        let url: URL
        if let bookmark = source.bookmark, let oldScope = source.scopeURL,
          let relative = source.relativePath
        {
          let scope: URL
          if let existing = scopes[oldScope.absoluteString] {
            scope = existing
          } else {
            scope = try Self.resolve(bookmark)
            if scope.startAccessingSecurityScopedResource() { granted.append(scope) }
            scopes[oldScope.absoluteString] = scope
          }
          guard !relative.hasPrefix("/"), !relative.split(separator: "/").contains("..") else {
            throw NativeExportError.message(
              "The saved source grant is invalid. Choose the original folder again.")
          }
          url = relative.isEmpty ? scope : scope.appendingPathComponent(relative)
        } else if let owned = source.ownedDirectory, let workspace {
          let parent = workspace.appendingPathComponent(
            "Jobs/\(owned.uuidString)/Sources", isDirectory: true
          )
          .resolvingSymlinksInPath().standardizedFileURL
          guard
            source.url.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
              == parent,
            source.url.resolvingSymlinksInPath().deletingLastPathComponent() == parent
          else {
            throw NativeExportError.message(
              "Captured original bytes no longer belong to this queue's private storage.")
          }
          url = source.url
        } else {
          throw NativeExportError.message(
            "The original's saved access grant is missing. Choose its folder again.")
        }
        sources[source.id] = url.standardizedFileURL
      }
      self.sources = sources
      self.accessing = granted
    } catch {
      for url in granted { url.stopAccessingSecurityScopedResource() }
      throw error
    }
  }
  deinit { for url in accessing { url.stopAccessingSecurityScopedResource() } }

  static func bookmark(_ url: URL) throws -> Data {
    #if os(macOS)
      return try url.bookmarkData(
        options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
    #else
      return try url.bookmarkData(
        options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
    #endif
  }
  private static func resolve(_ data: Data) throws -> URL {
    var stale = false
    #if os(macOS)
      let url = try URL(
        resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil,
        bookmarkDataIsStale: &stale)
    #else
      let url = try URL(
        resolvingBookmarkData: data, options: .withoutUI, relativeTo: nil,
        bookmarkDataIsStale: &stale)
    #endif
    guard url.isFileURL, !stale else {
      throw NativeExportError.message(
        "Saved folder access is stale. Choose the original and destination folders again.")
    }
    return url
  }

  func protect(_ output: URL, originals: [NativeExportSource], provenOwnership: Bool = false) throws
  {
    let destinationPath = output.resolvingSymlinksInPath().standardizedFileURL.path
    let exists = FileManager.default.fileExists(atPath: output.path)
    if exists && originals.contains(where: { $0.ownedDirectory != nil }) && !provenOwnership {
      throw NativeExportError.message(
        "A byte-only source cannot prove original identities in this destination. Choose a new output filename or an empty destination folder; existing files were preserved."
      )
    }
    let outputIdentity =
      FileManager.default.fileExists(atPath: output.path)
      ? try NativeExportStorage.identity(output) : nil
    for source in originals {
      guard outputIdentity != source.identity else { throw ExportError.originalDestination }
      if let authorized = source.authorizedIdentity {
        guard outputIdentity != authorized else { throw ExportError.originalDestination }
      }
      guard let current = sources[source.id] else {
        throw NativeExportError.message(
          "Original identity is unavailable. Start a new export from the full selection.")
      }
      let paths = [
        source.url.standardizedFileURL.path, current.standardizedFileURL.path,
        current.resolvingSymlinksInPath().standardizedFileURL.path,
      ]
      guard !paths.contains(destinationPath), !paths.contains(output.standardizedFileURL.path)
      else { throw ExportError.originalDestination }
      if FileManager.default.fileExists(atPath: current.path) {
        try MapleExporter.validateExportDestination(output, original: current)
      }
    }
  }
}
