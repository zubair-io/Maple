// BatchExportPanel+VM.swift — all-or-nothing iPhone photo export (#3852).
// The caller supplies sessions with their real source/sidecar stores. This
// model hydrates each session before MapleExporter bakes it, and never writes
// to an original or its sidecar.

#if os(iOS)
  import Foundation
  import MapleCore
  import Observation

  struct StagedBatchExport: Identifiable {
    let directory: URL
    let files: [URL]
    var id: URL { directory }
  }

  @MainActor
  @Observable
  final class BatchExportPanelVM {
    typealias SessionResolver = @MainActor (AssetRef) async throws -> EditSession
    typealias Exporter = @MainActor (EditSession, ExportOptions) async throws -> Data
    typealias Writer = @Sendable (Data, URL) throws -> Void

    var format: ExportFileFormat = .jpegSRGB
    var quality = 0.92
    var sizeOption: ExportSizeOption = .fast
    private(set) var isExporting = false
    private(set) var completedCount = 0
    private(set) var exportError: String?
    private(set) var stagedBatch: StagedBatchExport?

    private let resolveSession: SessionResolver
    private let exportData: Exporter
    private let writeFile: Writer
    private var generation = 0
    private var exportTask: Task<Void, Never>?

    init(
      resolveSession: @escaping SessionResolver,
      exportData: @escaping Exporter = {
        try await MapleExporter.exportData(session: $0, options: $1)
      },
      write: @escaping Writer = { try $0.write(to: $1, options: .atomic) }
    ) {
      self.resolveSession = resolveSession
      self.exportData = exportData
      self.writeFile = write
    }

    var options: ExportOptions {
      ExportOptions(format: format, quality: quality, sizeOption: sizeOption)
    }

    var showsQualityControl: Bool {
      switch format {
      case .jpegSRGB, .jpegP3, .heicP3: return true
      case .tiff16, .png: return false
      }
    }

    @discardableResult
    func begin(
      assets: [AssetRef],
      in temporaryRoot: URL = FileManager.default.temporaryDirectory
    ) -> Task<Void, Never> {
      exportTask?.cancel()
      generation &+= 1
      let attempt = generation
      isExporting = true
      completedCount = 0
      exportError = nil
      discardStagedBatch()
      let chosenOptions = options
      let task = Task { @MainActor [weak self] in
        guard let self else { return }
        await self.stage(
          assets: assets, options: chosenOptions, temporaryRoot: temporaryRoot, attempt: attempt)
      }
      exportTask = task
      return task
    }

    func cancelExport() {
      exportTask?.cancel()
      exportTask = nil
      generation &+= 1
      isExporting = false
      completedCount = 0
    }

    /// Called after the system destination completes or is dismissed. A
    /// cancelled share is not reported as an export success.
    func finishSharing(completed: Bool, error: Error?) {
      discardStagedBatch()
      if let error {
        exportError = error.localizedDescription
      } else if !completed {
        exportError = nil
      }
    }

    func discardStagedBatch() {
      guard let stagedBatch else { return }
      self.stagedBatch = nil
      Task { await Self.removeDirectory(stagedBatch.directory) }
    }

    private func stage(
      assets: [AssetRef], options: ExportOptions, temporaryRoot: URL, attempt: Int
    ) async {
      let directory = temporaryRoot.appendingPathComponent(
        "Maple-Batch-Export-\(UUID().uuidString)", isDirectory: true)
      do {
        guard !assets.isEmpty, Set(assets.map(\.id)).count == assets.count,
          assets.allSatisfy({ !$0.isVideo && !$0.isAudio && !$0.isStub })
        else {
          throw BatchExportError.invalidSelection
        }
        try await BlockingWork.run {
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        }
        try checkActive(attempt)
        var usedNames = Set<String>()
        var files: [URL] = []
        for asset in assets {
          try checkActive(attempt)
          let session = try await resolveSession(asset)
          try checkActive(attempt)
          guard session.asset.id == asset.id else { throw BatchExportError.wrongSession }
          if !session.hasLoadedSidecar { await session.loadSidecar() }
          try checkActive(attempt)
          guard session.hasLoadedSidecar else {
            throw session.sidecarError ?? BatchExportError.sidecarUnavailable(asset.displayName)
          }
          let data = try await exportData(session, options)
          try checkActive(attempt)
          let fileName = Self.uniqueFileName(
            for: asset, format: options.format, usedNames: &usedNames)
          let url = directory.appendingPathComponent(fileName)
          let writeFile = self.writeFile
          try await BlockingWork.run { try writeFile(data, url) }
          try checkActive(attempt)
          files.append(url)
          completedCount = files.count
        }
        try checkActive(attempt)
        stagedBatch = StagedBatchExport(directory: directory, files: files)
        isExporting = false
        exportTask = nil
      } catch {
        await Self.removeDirectory(directory)
        guard attempt == generation else { return }
        isExporting = false
        exportTask = nil
        if !(error is CancellationError) { exportError = error.localizedDescription }
      }
    }

    private func checkActive(_ attempt: Int) throws {
      guard attempt == generation, !Task.isCancelled else { throw CancellationError() }
    }

    private static func uniqueFileName(
      for asset: AssetRef, format: ExportFileFormat, usedNames: inout Set<String>
    ) -> String {
      let safeStem = asset.displayName
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: ":", with: "_")
        .replacingOccurrences(of: "\\", with: "_")
        .unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        .map(String.init).joined()
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let stem = safeStem.isEmpty || safeStem == "." || safeStem == ".." ? "Photo" : safeStem
      var suffix = 1
      var fileName = "\(stem).\(format.fileExtension)"
      while !usedNames.insert(fileName.folding(options: .caseInsensitive, locale: nil)).inserted {
        suffix += 1
        fileName = "\(stem)-\(suffix).\(format.fileExtension)"
      }
      return fileName
    }

    private static func removeDirectory(_ url: URL) async {
      // Cleanup must run even when the export task is cancelled. BlockingWork
      // correctly refuses to start new work for a cancelled parent task, so
      // use a fresh task for this best-effort removal.
      await Task.detached {
        _ = try? await BlockingWork.run {
          if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
          }
        }
      }.value
    }
  }

  private enum BatchExportError: LocalizedError {
    case invalidSelection
    case wrongSession
    case sidecarUnavailable(String)

    var errorDescription: String? {
      switch self {
      case .invalidSelection: return "Select one or more different photos to export."
      case .wrongSession: return "The selected photo changed before export. Please try again."
      case .sidecarUnavailable(let name):
        return "Could not load saved adjustments for \(name). Nothing was exported."
      }
    }
  }
#endif
