// XMPSidecarStore.swift — actor that reads/writes XMP sidecars with
// debounced 750ms writes and atomic temp-file rename (spec § 01).
//
// File naming: <raw-basename>.xmp (lowercase extension) in the same folder.
// Writes via temp → rename so partial writes are never visible.

import Foundation

// MARK: - XMPSidecarStore

/// Actor that manages XMP sidecar persistence for a single image.
///
/// Reads are synchronous (returns cached or reads from disk).
/// Writes are debounced: each `update()` call schedules a write 750 ms later;
/// a later call within that window resets the timer.
///
/// Usage:
/// ```swift
/// let store = XMPSidecarStore(rawURL: url)
/// let (model, culling) = await store.load()
/// var newModel = model
/// newModel.exposure = 1.5
/// await store.update(model: newModel, culling: culling)
/// await store.flush()   // Force immediate write before close.
/// ```
public actor XMPSidecarStore: WorkflowSidecarStoreProtocol {
  let primarySidecarURL: URL
  private let sidecarURL: URL
  private let variantId: String

  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?
  // Captured complete checkpoints survive failed publication; preview debounce
  // never coalesces distinct committed actions (#4046).
  private var pendingSemanticEdits: [WorkflowHistoryEntry] = []

  private var pendingMetadata: XmpMetadata? = nil

  private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
  private var nextSubscriberID: UInt64 = 0

  static let debounceInterval: Duration = .milliseconds(750)

  public init(rawURL: URL) {
    self.primarySidecarURL = SidecarPath.sidecarURL(for: rawURL)
    self.sidecarURL = SidecarPath.sidecarURL(for: rawURL)
    self.variantId = WorkflowContract.primaryVariantID
  }

  /// PhotoKit's canonical App Support file shares the same writer (#4047).
  init(sidecarURL: URL) {
    self.primarySidecarURL = sidecarURL
    self.sidecarURL = sidecarURL
    self.variantId = WorkflowContract.primaryVariantID
  }

  /// Bind the existing writer to a validated UUID sibling, including Photos' canonical root (#4063).
  public init(primarySidecarURL: URL, variantId: String) throws {
    self.primarySidecarURL = primarySidecarURL
    let filename = try WorkflowSidecarCore.variantFilename(
      primaryName: primarySidecarURL.lastPathComponent, variantId: variantId)
    self.sidecarURL = primarySidecarURL.deletingLastPathComponent().appendingPathComponent(filename)
    self.variantId = variantId
  }

  /// Load current model+culling from disk (or return cached).
  /// Returns defaults if no sidecar exists.
  public func load() async throws -> (AdjustmentModel, CullingState) {
    if let cached { return cached }
    let result = try readFromDisk()
    cached = result
    return result
  }

  /// Like `load()`, but returns `nil` when the sidecar file does not
  /// exist on disk. Lets callers (specifically `EditSession`) tell
  /// "fresh image, seed from as-shot WB" apart from "user has saved
  /// edits, honor them" without poking at FileManager themselves.
  public func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    if let cached { return cached }
    guard FileManager.default.fileExists(atPath: sidecarURL.path) else {
      try requirePrimaryAbsence()
      return nil
    }
    let result = try readFromDisk()
    cached = result
    return result
  }

  /// Schedule a debounced write. Resets the 750ms timer on each call.
  public func update(model: AdjustmentModel, culling: CullingState) {
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)

    pendingTask?.cancel()
    pendingTask = Task { [weak self] in
      do {
        try await Task.sleep(for: XMPSidecarStore.debounceInterval)
        await self?.writePending()
      } catch {
        // Task cancelled — a newer update superseded this one.
      }
    }
  }

  /// Schedule a debounced write including the IPTC/EXIF metadata block.
  /// Resets the 750ms timer on each call, superseding any pending write.
  public func update(model: AdjustmentModel, culling: CullingState, metadata: XmpMetadata) {
    pendingModel = model
    pendingCulling = culling
    pendingMetadata = metadata
    cached = (model, culling)

    pendingTask?.cancel()
    pendingTask = Task { [weak self] in
      do {
        try await Task.sleep(for: XMPSidecarStore.debounceInterval)
        await self?.writePending()
      } catch {
        // Task cancelled — a newer update superseded this one.
      }
    }
  }

  /// Force an immediate flush of any pending write (call before closing).
  public func flush() async {
    pendingTask?.cancel()
    pendingTask = nil
    await writePending()
  }

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    pendingTask?.cancel()
    pendingTask = nil
    try writeAtomically(model: model, culling: culling)
    pendingModel = nil
    pendingCulling = nil
    cached = (model, culling)
  }

  /// Record a real editor boundary, never an individual preview tick. Failed
  /// publication keeps this exact checkpoint for the next write/exit flush.
  public func commitSemantic(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) throws {
    try coordinateSidecarWrite { destination, existing in
      if let existing { try self.requireVariantWorkflow(in: existing) }
      let checkpoint = try WorkflowSidecarCore.checkpoint(
        xmp: self.serializedSidecar(model: model, culling: culling, existingXML: existing))
      let entry = WorkflowHistoryEntry(
        id: UUID().uuidString.lowercased(),
        createdAtMs: UInt64(Date().timeIntervalSince1970 * 1000),
        action: action, label: label, adjustmentXmp: checkpoint)
      // Invalid actions/checkpoints fail before entering the retry queue.
      _ = try WorkflowSidecarCore.commit(entry, in: checkpoint)
      self.pendingSemanticEdits.append(entry)
      if self.pendingSemanticEdits.count > WorkflowContract.historyLimit {
        self.pendingSemanticEdits.removeFirst(
          self.pendingSemanticEdits.count - WorkflowContract.historyLimit)
      }
      self.pendingTask?.cancel()
      self.pendingTask = nil
      self.pendingModel = model
      self.pendingCulling = culling
      self.cached = (model, culling)
      try self.writeSidecar(model: model, culling: culling, existingXML: existing, at: destination)
      self.pendingModel = nil
      self.pendingCulling = nil
    }
  }

  /// Workflow operations share the actor and primary path with adjustment writes.
  public func readWorkflow() throws -> SidecarWorkflow? {
    guard let xml = try existingSidecarXML(at: sidecarURL) else {
      try requirePrimaryAbsence()
      return nil
    }
    return try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId)
  }

  /// Publish pending authored adjustments and workflow in one atomic replacement.
  /// Validation finishes before the prior sidecar or pending state is changed.
  public func writeWorkflowConfirmed(_ workflow: SidecarWorkflow) throws {
    try coordinateSidecarWrite { destination, existing in
      let xml: String
      if let model = self.pendingModel, let culling = self.pendingCulling {
        xml = self.serializedSidecar(model: model, culling: culling, existingXML: existing)
      } else {
        xml = existing ?? XMPSerializer.serialize(model: .default, culling: CullingState())
      }
      // Validate the on-disk record even if a serializer would omit it.
      if let existing { try self.requireVariantWorkflow(in: existing) }
      let embedded = try WorkflowSidecarCore.embed(workflow, in: xml)
      try self.requireVariantWorkflow(in: embedded)
      let output = try self.appendingSemanticHistory(to: embedded)
      try self.publishSidecarXML(output, at: destination)
      self.pendingSemanticEdits.removeAll()
    }
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = nil
    pendingCulling = nil
    pendingMetadata = nil
  }

  /// Settle pending authored state with a throwing boundary before reading a checkpoint.
  public func readWorkflowXML() throws -> String? {
    try settleWorkflowWrites()
    let xml = try existingSidecarXML(at: sidecarURL)
    if xml == nil { try requirePrimaryAbsence() }
    if let xml { try requireVariantWorkflow(in: xml) }
    return xml
  }

  public func publishWorkflow(_ command: WorkflowPublication) throws -> String {
    try settleWorkflowWrites()
    return try coordinateSidecarWrite { destination, existing in
      let output = try command.output(current: existing, variantId: self.variantId)
      // Parse before publication; a failure never changes the original checkpoint.
      let restored = try XMPParser.parse(output)
      if output != existing { try self.publishSidecarXML(output, at: destination) }
      self.cached = restored
      return output
    }
  }

  private func settleWorkflowWrites() throws {
    pendingTask?.cancel()
    pendingTask = nil
    guard let model = pendingModel, let culling = pendingCulling else { return }
    try writeAtomically(model: model, culling: culling)
    pendingModel = nil
    pendingCulling = nil
    cached = (model, culling)
  }

  /// Returns an async stream of errors encountered during background writes.
  public func errors() -> AsyncStream<Error> {
    let id = nextSubscriberID
    nextSubscriberID &+= 1  // wrapping increment — prevents trap in long-lived processes
    return AsyncStream { continuation in
      subscribers[id] = continuation
      continuation.onTermination = { [weak self] _ in
        Task { [weak self] in
          await self?.removeSubscriber(id)
        }
      }
    }
  }

  private func removeSubscriber(_ id: UInt64) {
    subscribers.removeValue(forKey: id)
  }

  /// Returns the sidecar URL regardless of whether it exists.
  public var url: URL { sidecarURL }

  // MARK: Private

  /// The sidecar text currently on disk, or nil when there is none.
  ///
  /// The write path reads it for the two things a model+culling write must
  /// not destroy: the IPTC/EXIF metadata block, and the passthrough bucket
  /// (#2233). Disk is the carrier for both rather than in-memory state
  /// threaded down from `EditSession`, so an externally-edited sidecar
  /// contributes its current contents instead of a stale snapshot taken at
  /// open time.
  private func existingSidecarXML(at url: URL) throws -> String? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try String(contentsOf: url, encoding: .utf8)
  }

  private func readFromDisk() throws -> (AdjustmentModel, CullingState) {
    guard FileManager.default.fileExists(atPath: sidecarURL.path) else {
      try requirePrimaryAbsence()
      return (.default, CullingState())
    }
    let data = try Data(contentsOf: sidecarURL)
    _ = try WorkflowSidecarCore.variantWorkflow(
      xmp: String(decoding: data, as: UTF8.self), variantId: variantId)
    return try XMPParser.parse(data: data)
  }

  private func writePending() async {
    guard let model = pendingModel, let culling = pendingCulling else { return }
    do {
      try writeAtomically(model: model, culling: culling)
      pendingModel = nil
      pendingCulling = nil
    } catch {
      for subscriber in subscribers.values {
        subscriber.yield(error)
      }
    }
  }

  private func writeAtomically(model: AdjustmentModel, culling: CullingState) throws {
    try coordinateSidecarWrite { destination, existing in
      try self.writeSidecar(model: model, culling: culling, existingXML: existing, at: destination)
    }
  }

  private func writeSidecar(
    model: AdjustmentModel, culling: CullingState, existingXML: String?, at destination: URL
  ) throws {
    if let existingXML { try requireVariantWorkflow(in: existingXML) }
    let xml = try appendingSemanticHistory(
      to: serializedSidecar(model: model, culling: culling, existingXML: existingXML))
    try publishSidecarXML(xml, at: destination)
    pendingSemanticEdits.removeAll()
    pendingMetadata = nil
  }

  private func appendingSemanticHistory(to xml: String) throws -> String {
    guard !pendingSemanticEdits.isEmpty else { return xml }
    try requireVariantWorkflow(in: xml)
    var workflow = try WorkflowSidecarCore.read(xmp: xml)
    for entry in pendingSemanticEdits {
      let candidate =
        try workflow.map {
          try WorkflowSidecarCore.embed($0, in: entry.adjustmentXmp)
        } ?? entry.adjustmentXmp
      let committed = try WorkflowSidecarCore.commit(entry, in: candidate)
      workflow = try WorkflowSidecarCore.read(xmp: committed)
    }
    guard let workflow else {
      throw WorkflowSidecarError(message: "Committed history did not produce a workflow record")
    }
    return try WorkflowSidecarCore.embed(workflow, in: xml)
  }

  private func requireVariantWorkflow(in xml: String) throws {
    _ = try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId)
  }

  private func requirePrimaryAbsence() throws {
    guard variantId == WorkflowContract.primaryVariantID else {
      throw WorkflowSidecarError(
        message:
          "Variant sidecar is missing: \(sidecarURL.lastPathComponent). Restore it before editing.")
    }
  }

  /// Cooperate with separate editor/variant store instances on this same file.
  private func coordinateSidecarWrite<T>(_ write: (URL, String?) throws -> T) throws -> T {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var error: NSError?
    var result: Result<T, Error>?
    coordinator.coordinate(writingItemAt: sidecarURL, options: [], error: &error) { url in
      result = Result {
        let existing = try self.existingSidecarXML(at: url)
        if existing == nil { try self.requirePrimaryAbsence() }
        return try write(url, existing)
      }
    }
    if let error { throw error }
    guard let result else {
      throw WorkflowSidecarError(
        message: "Unable to coordinate the sidecar save. Reopen and retry.")
    }
    return try result.get()
  }

  private func serializedSidecar(
    model: AdjustmentModel, culling: CullingState, existingXML: String?
  ) -> String {
    // Non-destructive: a model/culling-only write must NOT drop an existing
    // IPTC/EXIF metadata block (e.g. one authored by the batch editor). Use
    // the pending metadata if this write carries one, otherwise preserve
    // whatever is already on disk. (parseMetadata of a no-metadata sidecar
    // returns an empty struct, which we treat as "no block".)
    let metadataOnDisk =
      existingXML
      .map(XMPParser.parseMetadata)
      .flatMap { $0.isEmpty ? nil : $0 }
    let metadata = pendingMetadata ?? metadataOnDisk
    // Likewise for every field Maple does not model at all (#2233) — the
    // Lightroom masks, history, snapshots and display-referred curves that
    // this writer used to delete on the first slider nudge.
    let passthrough = existingXML.map(XMPParser.parsePassthrough) ?? .empty
    let xml: String
    if let metadata, !metadata.isEmpty {
      xml = XMPSerializer.serialize(
        model: model, culling: culling, metadata: metadata, passthrough: passthrough)
    } else {
      xml = XMPSerializer.serialize(
        model: model, culling: culling, passthrough: passthrough)
    }
    return xml
  }

  private func publishSidecarXML(_ xml: String, at destination: URL) throws {
    guard let data = xml.data(using: .utf8) else {
      throw XMPStoreError.encodingError
    }
    let tmpURL = destination.deletingLastPathComponent()
      .appendingPathComponent(".\(destination.lastPathComponent).tmp")
    try data.write(to: tmpURL, options: .atomic)
    // Atomic rename
    if FileManager.default.fileExists(atPath: destination.path) {
      _ = try FileManager.default.replaceItemAt(destination, withItemAt: tmpURL)
    } else {
      try FileManager.default.moveItem(at: tmpURL, to: destination)
    }
  }
}

// MARK: - XMPStoreError

public enum XMPStoreError: Error, LocalizedError {
  case encodingError

  public var errorDescription: String? {
    switch self {
    case .encodingError: return "XMP serialization produced non-UTF8 data"
    }
  }
}
