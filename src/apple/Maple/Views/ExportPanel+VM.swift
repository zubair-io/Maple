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
// work hops away via `BlockingWork.run` (a Dispatch queue, deliberately
// NOT the cooperative pool, which is core-count sized and would starve
// under repeated exports — PR #3455 review) and hops back once.
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
  /// and unisolated on purpose: `encodeOffPool` below is what moves it off
  /// the main actor, so *where* it runs is decided by this file (and
  /// asserted by `ExportPanelVMTests`) rather than by the closure's own
  /// isolation.
  typealias Encoder = @Sendable (CIImage, ExportOptions) throws -> Data
  /// Puts the encoded bytes on disk. Injected for the same reason the
  /// encode is: it is blocking (a 16-bit TIFF of a 100MP frame is most of a
  /// gigabyte) and its exact ordering against cancellation is what
  /// `testCancelBetweenTheWriteAndThePublishRemovesTheOrphanedFile` pins.
  typealias Writer = @Sendable (Data, URL) throws -> Void

  var format: ExportFileFormat = .jpegSRGB
  var quality: Double = 0.92
  private(set) var isExporting = false
  private(set) var exportError: String?
  /// Non-nil once `stageForSharing` has written the file; the panel binds
  /// its share sheet to it and clears it when the sheet goes away.
  var stagedFile: StagedExportFile?

  private let render: Renderer
  private let encode: Encoder
  private let writeFile: Writer
  /// Bumped by every start and every cancel. A result whose generation no
  /// longer matches belongs to an attempt the user walked away from — it is
  /// dropped rather than published over whatever replaced it.
  private var generation = 0
  private var exportTask: Task<Void, Never>?

  init(
    render: @escaping Renderer = { try await $0.renderForExport() },
    encode: @escaping Encoder = { try MapleExporter.encode($0, options: $1) },
    write: @escaping Writer = { try $0.write(to: $1, options: .atomic) }
  ) {
    self.render = render
    self.encode = encode
    self.writeFile = write
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
      let data = try await encodeOffPool(image)
      try guardLive(gen)
      let url = directory.appendingPathComponent(outputFileName(for: session.asset))
      try await publish(data, to: url, gen: gen)
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

  /// The expensive half, off the main actor AND off the cooperative pool.
  /// `BlockingWork.run` hands it to a Dispatch queue: a `Task.detached`
  /// would park a cooperative thread for the whole bake, and a few
  /// start/cancel cycles would exhaust a pool sized to the core count
  /// (PR #3455 review).
  private func encodeOffPool(_ image: CIImage) async throws -> Data {
    let encode = self.encode
    let options = self.options
    return try await BlockingWork.run { try encode(image, options) }
  }

  /// Writes the bytes and publishes them — deleting the file again if the
  /// attempt goes stale in the window between the two. Without that, a
  /// Cancel landing just after the write orphans up to a gigabyte in the
  /// temp directory that nothing ever comes back for (PR #3455 review).
  private func publish(_ data: Data, to url: URL, gen: Int) async throws {
    let writeFile = self.writeFile
    try await BlockingWork.run { try writeFile(data, url) }
    do {
      try guardLive(gen)
    } catch {
      // Only ever this attempt's orphan: an earlier attempt that already
      // published the same filename still owns that file.
      if stagedFile?.url != url {
        try? FileManager.default.removeItem(at: url)
      }
      throw error
    }
    stagedFile = StagedExportFile(url: url)
  }
}
