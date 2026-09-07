// ExportPanel+VM.swift — view-model for the editor's Export panel (#3403).
//
// Owns the panel's transient state (format, quality, busy flag, surfaced
// error) and the platform-neutral half of an export attempt: rendering the
// session at full quality and staging the bytes on disk as
// `<displayName>.<ext>` so the iOS share sheet can hand a real file to
// Files / Photos / AirDrop. The macOS save-panel path stays in
// `MapleExporter.exportWithSavePanel` — it owns its own destination URL.
//
// #3450 — the render and the encode run OFF the main actor, and an attempt
// is a cancellable task rather than a bare `await`. `EditSession` is
// `@MainActor`, so the first wiring baked a 100MP RAW on the main thread:
// the phone editor froze for the whole export (its own busy state could
// not even animate) and XCUITest's accessibility query gave up with
// "main thread busy for 30.0s". Only the published state below — busy
// flag, error string, staged file — belongs on the main actor; the heavy
// work hops to the cooperative pool and hops back once.
//
// Pattern (issue #192): the `+VM.swift` sibling MUST NOT `import SwiftUI`
// (a grep gate in CI enforces it) so every branch here is unit-testable
// from `MapleTests/ExportPanelVMTests` without a live render — both the
// render and the encode are injected seams.

import CoreImage
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
  /// Bakes `session` into a full-resolution CIImage graph. `@MainActor`
  /// because `EditSession` is; the work here is cheap — the graph is lazy,
  /// and `RenderActor` already owns the decode and the develop.
  typealias Renderer = @MainActor (EditSession) async throws -> CIImage
  /// Evaluates that graph and encodes it — the expensive half. Synchronous
  /// and unisolated on purpose: `encodeOffMainActor` below is what puts it
  /// on a detached task, so *where* it runs is decided by this file (and
  /// asserted by `ExportPanelVMTests`) rather than by the closure's own
  /// isolation.
  typealias Encoder = @Sendable (CIImage, ExportOptions) throws -> Data

  var format: ExportFileFormat = .jpegSRGB
  var quality: Double = 0.92
  private(set) var isExporting = false
  private(set) var exportError: String?
  /// Non-nil once `stageForSharing` has written the file; the panel binds
  /// its share sheet to it and clears it when the sheet goes away.
  var stagedFile: StagedExportFile?

  private let render: Renderer
  private let encode: Encoder
  /// Bumped by every start and every cancel. A result whose generation no
  /// longer matches belongs to an attempt the user walked away from — it is
  /// dropped rather than published over whatever replaced it.
  private var generation = 0
  private var exportTask: Task<Void, Never>?

  init(
    render: @escaping Renderer = { try await $0.renderForExport() },
    encode: @escaping Encoder = { try MapleExporter.encode($0, options: $1) }
  ) {
    self.render = render
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

  // MARK: - Attempts

  /// Runs one export attempt as a cancellable task, owning the busy flag
  /// and surfacing any thrown error on `exportError` for the panel to
  /// display. This is the macOS save-panel path's entry point; the returned
  /// task is its join point (and the unit tests').
  @discardableResult
  func begin(_ work: @escaping @MainActor () async throws -> Void) -> Task<Void, Never> {
    let gen = startAttempt()
    let task = Task { @MainActor [weak self] in
      do {
        try await work()
        self?.finish(gen, with: nil)
      } catch {
        self?.finish(gen, with: error)
      }
    }
    exportTask = task
    return task
  }

  /// Full-quality render of `session`, written into `directory` and
  /// published on `stagedFile` for the share sheet. Leaves `stagedFile` nil
  /// (and `exportError` set) when the render, the encode, or the write
  /// fails, and publishes nothing at all when the attempt was cancelled or
  /// superseded by a newer one.
  @discardableResult
  func beginStagingForSharing(
    session: EditSession,
    in directory: URL = FileManager.default.temporaryDirectory
  ) -> Task<Void, Never> {
    let gen = startAttempt()
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.runStaging(session: session, directory: directory, gen: gen)
    }
    exportTask = task
    return task
  }

  /// `beginStagingForSharing` plus the join — the shape the tests and any
  /// `async` call site read best.
  func stageForSharing(
    session: EditSession,
    in directory: URL = FileManager.default.temporaryDirectory
  ) async {
    await beginStagingForSharing(session: session, in: directory).value
  }

  /// The panel's Cancel while an export is running: stop the task, drop
  /// whatever it produces afterwards, and clear the busy state now so the
  /// UI comes back immediately instead of waiting out a bake that has no
  /// interruption point once `CIContext` has entered it.
  func cancelExport() {
    exportTask?.cancel()
    exportTask = nil
    generation &+= 1
    isExporting = false
  }

  // MARK: - Internals

  private func startAttempt() -> Int {
    exportTask?.cancel()
    generation &+= 1
    isExporting = true
    exportError = nil
    return generation
  }

  private func finish(_ gen: Int, with error: Error?) {
    guard gen == generation else { return }
    exportTask = nil
    isExporting = false
    guard let error, !(error is CancellationError) else { return }
    exportError = error.localizedDescription
  }

  private func runStaging(session: EditSession, directory: URL, gen: Int) async {
    do {
      let image = try await render(session)
      try guardLive(gen)
      let data = try await encodeOffMainActor(image, options: options)
      try guardLive(gen)
      let url = directory.appendingPathComponent(outputFileName(for: session.asset))
      try await Self.write(data, to: url)
      try guardLive(gen)
      stagedFile = StagedExportFile(url: url)
      finish(gen, with: nil)
    } catch {
      finish(gen, with: error)
    }
  }

  /// Throws `CancellationError` when this attempt has been cancelled or
  /// superseded — the single guard every publish point goes through.
  private func guardLive(_ gen: Int) throws {
    guard gen == generation, !Task.isCancelled else { throw CancellationError() }
  }

  /// The expensive half on a detached task, with cancellation bridged back
  /// (a detached child inherits none). `Task.detached` does not adopt the
  /// caller's actor, so this holds however the panel was entered.
  private func encodeOffMainActor(_ image: CIImage, options: ExportOptions) async throws -> Data {
    let encode = self.encode
    let work = Task.detached(priority: .userInitiated) { () throws -> Data in
      try Task.checkCancellation()
      return try encode(image, options)
    }
    return try await withTaskCancellationHandler {
      try await work.value
    } onCancel: {
      work.cancel()
    }
  }

  /// A 16-bit TIFF of a 100MP frame is most of a gigabyte — the write goes
  /// off the main actor for the same reason the encode does.
  private static func write(_ data: Data, to url: URL) async throws {
    try await Task.detached(priority: .userInitiated) {
      try data.write(to: url, options: .atomic)
    }.value
  }
}
