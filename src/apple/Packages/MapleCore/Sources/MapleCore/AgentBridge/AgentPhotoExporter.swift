import Foundation
import MapleAgentWire

/// Uses the same full-quality pipeline and encode defaults as the Export panel.
/// Files live in the app's Documents/Exports so sandboxed builds need no
/// additional folder grant. A fresh name per call never replaces an original.
enum AgentPhotoExporter {
  @MainActor
  static func export(
    session: EditSession, revision: String, directory: URL?,
    validate: () throws -> Void
  ) async throws -> AgentPayload {
    let asset = session.asset
    let name = URL(fileURLWithPath: asset.displayName).deletingPathExtension().lastPathComponent
    let stem = name.isEmpty || name == "." || name == ".." ? "Photo" : String(name.prefix(100))
    let sourceScope = asset.scopeParentURL ?? asset.primaryURL
    let reading = sourceScope?.startAccessingSecurityScopedResource() ?? false
    defer { if reading { sourceScope?.stopAccessingSecurityScopedResource() } }
    let original = asset.primaryURL
    let data = try await MapleExporter.exportData(session: session, options: .defaults)
    try Task.checkCancellation()
    try validate()
    let files = try await BlockingWork.run {
      let root =
        try directory
        ?? FileManager.default.url(
          for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent("Exports", isDirectory: true)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let destination = root.appendingPathComponent("\(stem)-\(UUID().uuidString).jpg")
      let staged = root.appendingPathComponent(".\(UUID().uuidString).tmp")
      try MapleExporter.validateExportDestination(destination, original: original)
      do {
        try data.write(to: staged, options: .atomic)
        return (staged: staged, destination: destination)
      } catch {
        try? FileManager.default.removeItem(at: staged)
        throw error
      }
    }
    defer { try? FileManager.default.removeItem(at: files.staged) }
    try Task.checkCancellation()
    try validate()
    try Task.checkCancellation()
    // Only the same-directory rename runs on the main actor. No suspension
    // separates the final revision/cancellation fence from publication.
    // moveItem refuses an existing destination; the JPEG write stays off-actor.
    try FileManager.default.moveItem(at: files.staged, to: files.destination)
    let destination = files.destination
    return AgentPayload(result: [
      "photo_id": .string(asset.id.uuidString), "revision": .string(revision),
      "path": .string(destination.path), "file_name": .string(destination.lastPathComponent),
      "format": .string(ExportOptions.defaults.format.rawValue),
      "byte_count": .int(data.count),
    ])
  }
}
