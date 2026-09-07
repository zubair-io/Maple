// ExportPanel+VM.swift — view-model for the editor's Export panel (#3403).
//
// Owns the panel's transient state (format, quality, busy flag, surfaced
// error) and the platform-neutral half of an export attempt: rendering the
// session at full quality and staging the bytes on disk as
// `<displayName>.<ext>` so the iOS share sheet can hand a real file to
// Files / Photos / AirDrop. The macOS save-panel path stays in
// `MapleExporter.exportWithSavePanel` — it owns its own destination URL.
//
// Pattern (issue #192): the `+VM.swift` sibling MUST NOT `import SwiftUI`
// (a grep gate in CI enforces it) so every branch here is unit-testable
// from `MapleTests/ExportPanelVMTests` without a live render — the encoder
// is injected, defaulting to `MapleExporter.exportData`.

import Foundation
import MapleCore
import Observation

/// A rendered export written to disk, ready for the share sheet.
struct StagedExportFile: Identifiable {
  let url: URL
  var id: URL { url }
}

@MainActor
@Observable
final class ExportPanelVM {
  /// Renders `session` and encodes it per the options — the seam the tests
  /// replace so the file-staging contract is exercised without a RAW.
  typealias Encoder = @MainActor (EditSession, ExportOptions) async throws -> Data

  var format: ExportFileFormat = .jpegSRGB
  var quality: Double = 0.92
  private(set) var isExporting = false
  private(set) var exportError: String?
  /// Non-nil once `stageForSharing` has written the file; the panel binds
  /// its share sheet to it and clears it when the sheet goes away.
  var stagedFile: StagedExportFile?

  private let encode: Encoder

  init(
    encode: @escaping Encoder = { try await MapleExporter.exportData(session: $0, options: $1) }
  ) {
    self.encode = encode
  }

  var options: ExportOptions {
    ExportOptions(format: format, quality: quality)
  }

  /// Lossy formats expose the quality slider; TIFF and PNG are lossless.
  var showsQualityControl: Bool {
    switch format {
    case .jpegSRGB, .jpegP3, .heicP3: return true
    case .tiff16, .png: return false
    }
  }

  func outputFileName(for asset: AssetRef) -> String {
    "\(asset.displayName).\(format.fileExtension)"
  }

  /// Runs one export attempt, owning the busy flag and surfacing any
  /// thrown error on `exportError` for the panel to display.
  func perform(_ export: () async throws -> Void) async {
    isExporting = true
    exportError = nil
    defer { isExporting = false }
    do {
      try await export()
    } catch {
      exportError = error.localizedDescription
    }
  }

  /// Full-quality render of `session`, written atomically into `directory`
  /// and published on `stagedFile` for the share sheet. Leaves `stagedFile`
  /// nil (and `exportError` set) when the render or the write fails.
  func stageForSharing(
    session: EditSession,
    in directory: URL = FileManager.default.temporaryDirectory
  ) async {
    await perform {
      let data = try await encode(session, options)
      let url = directory.appendingPathComponent(outputFileName(for: session.asset))
      try data.write(to: url, options: .atomic)
      stagedFile = StagedExportFile(url: url)
    }
  }
}
