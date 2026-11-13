// XMPSidecarStore.swift — actor that reads/writes XMP sidecars with
// debounced 750ms writes and atomic temp-file rename (spec § 01).
//
// File naming: <raw-basename>.xmp (lowercase extension) in the same folder.
// Writes via temp → rename so partial writes are never visible.

import Darwin
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
  let rawURL: URL?
  let sidecarURL: URL
  let variantId: String
  private let afterPublication: (@Sendable () throws -> Void)?

  var cached: (AdjustmentModel, CullingState)?
  // Exact bytes last loaded or published by this store: the document the
  // editor's model represents. The editor can hold a model while another writer
  // replaces the file; a save then merges onto the file instead of overwriting
  // it (#4983), and derivatives are never certified against a changed file (#5348).
  var observedSidecarXML: String?
  var hasObservedSidecar = false
  // Head of the history record the next entry is based on (`parentId`).
  var lineageHeadID = ""
  var stagedAdoption: StagedAdoption?
  let reconciliationHub = SidecarReconciliationHub()
  var removalObservedRevision: RemovalSidecarRevision?
  var removalRecovery = LocalRemovalCommitRecovery()
  var pendingTask: Task<Void, Never>?
  var pendingModel: AdjustmentModel?
  var pendingCulling: CullingState?
  // Captured complete checkpoints survive failed publication; preview debounce
  // never coalesces distinct committed actions (#4046).
  var pendingSemanticEdits: [WorkflowHistoryEntry] = []

  var pendingMetadata: XmpMetadata? = nil

  private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
  private var nextSubscriberID: UInt64 = 0

  static let debounceNanoseconds: UInt64 = 750_000_000
  static let debounceInterval: Duration = .nanoseconds(debounceNanoseconds)

  public init(rawURL: URL) {
    self.primarySidecarURL = SidecarPath.sidecarURL(for: rawURL)
    self.rawURL = rawURL
    self.sidecarURL = SidecarPath.sidecarURL(for: rawURL)
    self.variantId = WorkflowContract.primaryVariantID
    self.afterPublication = nil
  }

  /// PhotoKit's canonical App Support file shares the same writer (#4047).
  init(sidecarURL: URL, afterPublication: (@Sendable () throws -> Void)? = nil) {
    self.rawURL = nil
    self.primarySidecarURL = sidecarURL
    self.sidecarURL = sidecarURL
    self.variantId = WorkflowContract.primaryVariantID
    self.afterPublication = afterPublication
  }

  /// Bind the existing writer to a validated UUID sibling, including Photos' canonical root (#4063).
  public init(primarySidecarURL: URL, variantId: String) throws {
    try self.init(primarySidecarURL: primarySidecarURL, variantId: variantId, rawURL: nil)
  }

  init(primarySidecarURL: URL, variantId: String, rawURL: URL?) throws {
    self.rawURL = rawURL
    self.primarySidecarURL = primarySidecarURL
    let filename = try WorkflowSidecarCore.variantFilename(
      primaryName: primarySidecarURL.lastPathComponent, variantId: variantId)
    self.sidecarURL = primarySidecarURL.deletingLastPathComponent().appendingPathComponent(filename)
    self.variantId = variantId
    self.afterPublication = nil
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
      observedSidecarXML = nil
      hasObservedSidecar = true
      lineageHeadID = ""
      removalObservedRevision = .missing
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
        try await Task.sleep(nanoseconds: XMPSidecarStore.debounceNanoseconds)
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
        try await Task.sleep(nanoseconds: XMPSidecarStore.debounceNanoseconds)
        await self?.writePending()
      } catch {
        // Task cancelled — a newer update superseded this one.
      }
    }
  }

  /// Force an immediate flush of any pending write (call before closing).
  public func flush() async {
    let task = pendingTask
    pendingTask = nil
    task?.cancel()
    _ = await task?.result
    await writePending()
  }

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    let task = pendingTask
    pendingTask = nil
    task?.cancel()
    _ = await task?.result
    let saved = try writeAtomically(model: model, culling: culling, durable: true)
    pendingModel = nil
    pendingCulling = nil
    cached = (saved, culling)
  }

  /// Confirm an accepted stack only after its companions were published.
  /// Comparing the loaded stack under the same lock as every local write
  /// prevents an older Maple writer from replacing a newer removal (#3940).
  public func removalRevision() throws -> RemovalSidecarRevision {
    let current = try RemovalSidecarRevision(xml: existingSidecarXML(at: sidecarURL))
    if let removalObservedRevision, current != removalObservedRevision {
      // A retry cannot bless changed external XML while retaining the old
      // in-memory adjustment model. Reopen the photo to hydrate a new session.
      throw RemovalError.saveConflict
    }
    removalObservedRevision = current
    return current
  }

  public func writeRemovalConfirmed(
    records: String, expectedRecords: String, model: AdjustmentModel, culling: CullingState,
    expectedSidecarRevision: RemovalSidecarRevision? = nil
  ) throws {
    _ = try RemovalBridge.assetNames(records: records)
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = nil
    pendingCulling = nil
    let saved = try writeAtomically(
      model: model, culling: culling, durable: true, removalChange: (expectedRecords, records),
      expectedSidecarRevision: expectedSidecarRevision)
    cached = (saved, culling)
    removalRecovery.clear()
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
  func existingSidecarXML(at url: URL) throws -> String? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try String(contentsOf: url, encoding: .utf8)
  }

  private func readFromDisk() throws -> (AdjustmentModel, CullingState) {
    guard FileManager.default.fileExists(atPath: sidecarURL.path) else {
      try requirePrimaryAbsence()
      observedSidecarXML = nil
      hasObservedSidecar = true
      lineageHeadID = ""
      removalObservedRevision = .missing
      return (.default, CullingState())
    }
    let data = try Data(contentsOf: sidecarURL)
    let xml = String(decoding: data, as: UTF8.self)
    let head = try WorkflowSidecarCore.headId(xmp: xml, variantId: variantId)
    let result = try XMPParser.parse(data: data)
    observedSidecarXML = xml
    hasObservedSidecar = true
    lineageHeadID = head
    removalObservedRevision = try RemovalSidecarRevision(xml: xml)
    return result
  }

  private func writePending() async {
    // A removal-owned photo's lease can be briefly held by a peer writer; yield
    // and retry rather than surfacing the contention as a failed save (#3940).
    for attempt in 0..<50 {
      guard !Task.isCancelled, let model = pendingModel, let culling = pendingCulling else {
        return
      }
      do {
        try writeAtomically(model: model, culling: culling, durable: false)
        pendingModel = nil
        pendingCulling = nil
        return
      } catch RemovalError.saveConflict where attempt < 49 {
        do { try await Task.sleep(for: .milliseconds(10)) } catch { return }
      } catch {
        for subscriber in subscribers.values { subscriber.yield(error) }
        return
      }
    }
  }

  @discardableResult
  func writeAtomically(
    model: AdjustmentModel, culling: CullingState, durable: Bool,
    removalChange: (expected: String, records: String)? = nil,
    expectedSidecarRevision: RemovalSidecarRevision? = nil
  ) throws -> AdjustmentModel {
    try coordinateSidecarWrite(reconciling: true, removalChange: removalChange != nil) {
      destination, existing in
      let attempt = removalChange.map {
        LocalRemovalCommitAttempt(
          model: model, expected: $0.expected, records: $0.records,
          revision: expectedSidecarRevision)
      }
      if let existing { try self.requireVariantWorkflow(in: existing) }
      if let recovered = try self.removalRecovery.recover(
        attempt, xml: existing, rawURL: self.rawURL, at: destination)
      {
        self.pendingSemanticEdits.removeAll()
        self.pendingMetadata = nil
        self.removalObservedRevision = try RemovalSidecarRevision(xml: existing)
        return recovered
      }
      if removalChange != nil {
        // An accepted stack is a compare-and-swap, never a merge onto a file
        // the editor has not seen.
        if self.hasObservedSidecar, existing != self.observedSidecarXML {
          throw XMPStoreError.externalConflict(self.sidecarURL)
        }
        if let expectedSidecarRevision,
          try RemovalSidecarRevision(xml: existing) != expectedSidecarRevision
        {
          throw RemovalError.saveConflict
        }
      }
      return try self.writeSidecar(
        model: model, culling: culling, existingXML: existing, at: destination,
        durable: durable || removalChange != nil, removalChange: removalChange, attempt: attempt)
    }
  }

  /// A save the file no longer matches is merged onto it, never refused (#4983).
  @discardableResult
  func writeSidecar(
    model: AdjustmentModel, culling: CullingState, existingXML: String?, at destination: URL,
    durable: Bool, removalChange: (expected: String, records: String)? = nil,
    attempt: LocalRemovalCommitAttempt? = nil
  ) throws -> AdjustmentModel {
    if attempt == nil { try removalRecovery.requireOrdinaryWrite(xml: existingXML) }
    if let existingXML { try requireVariantWorkflow(in: existingXML) }
    let serialized = try serializedSidecarAndModel(
      model: model, culling: culling, existingXML: existingXML, removalChange: removalChange)
    let incoming = serialized.xml
    let reconciled =
      removalChange == nil
      ? try reconcile(incoming: incoming, existing: existingXML) : (xml: incoming, merged: false)
    let xml = try appendingSemanticHistory(to: reconciled.xml, merged: reconciled.merged)
    let adoption =
      reconciled.merged && reconciliationHub.hasSubscribers
      ? PendingAdoption(
        represented: incoming, document: ReconciledSidecar(xml: xml, model: model, culling: culling)
      )
      : nil
    if let attempt { removalRecovery.begin(attempt, xml: xml, priorXML: existingXML) }
    try publishSidecarXML(
      xml, at: destination, durable: durable, adoption: adoption,
      unchanged: reconciled.merged && xml == existingXML)
    let saved = serialized.model
    pendingSemanticEdits.removeAll()
    pendingMetadata = nil
    return saved
  }

  func requirePrimaryAbsence() throws {
    guard variantId == WorkflowContract.primaryVariantID else {
      throw WorkflowSidecarError(
        message:
          "Variant sidecar is missing: \(sidecarURL.lastPathComponent). Restore it before editing.")
    }
  }

  /// Cooperate with separate editor/variant store instances on this same file.
  /// A `reconciling` writer decides for itself what to do with a file that no
  /// longer matches the observed revision; every other writer is refused.
  /// Removal-owned photos additionally take the persistent lease (#3940).
  func coordinateSidecarWrite<T>(
    reconciling: Bool = false, removalChange: Bool = false, _ write: (URL, String?) throws -> T
  ) throws -> T {
    try withRemovalLease(removalChange: removalChange) {
      let coordinator = NSFileCoordinator(filePresenter: nil)
      var error: NSError?
      var result: Result<T, Error>?
      coordinator.coordinate(writingItemAt: sidecarURL, options: [], error: &error) { url in
        result = Result {
          let existing = try self.existingSidecarXML(at: url)
          if existing == nil { try self.requirePrimaryAbsence() }
          if !reconciling, self.hasObservedSidecar, existing != self.observedSidecarXML {
            throw XMPStoreError.externalConflict(self.sidecarURL)
          }
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
  }

  /// Keep the observed XMP revision stable while a local derivative is written.
  func writeDerivativeIfCurrent(_ write: @Sendable () throws -> Void) throws {
    guard hasObservedSidecar else { throw CancellationError() }
    try coordinateSidecarWrite(reconciling: true) { _, existing in
      try self.requireObserved(existing)
      try write()
    }
  }

  func requireObservedRevisionCurrent() throws {
    guard hasObservedSidecar else { throw CancellationError() }
    try coordinateSidecarWrite(reconciling: true) { _, existing in
      try self.requireObserved(existing)
    }
  }

  /// A merge the editor has not adopted yet is not an outside edit, but no
  /// derivative rendered from the stale model may be certified against it.
  private func requireObserved(_ existing: String?) throws {
    guard existing == observedSidecarXML else {
      if let staged = stagedAdoption, existing == staged.published { throw CancellationError() }
      throw XMPStoreError.externalConflict(sidecarURL)
    }
  }

  func serializedSidecar(
    model: AdjustmentModel, culling: CullingState, existingXML: String?,
    removalChange: (expected: String, records: String)? = nil
  ) throws -> String {
    try serializedSidecarAndModel(
      model: model, culling: culling, existingXML: existingXML, removalChange: removalChange
    ).xml
  }

  /// The serialized sidecar and the model it actually carries: an ordinary
  /// save keeps the accepted removal stack already on disk.
  private func serializedSidecarAndModel(
    model: AdjustmentModel, culling: CullingState, existingXML: String?,
    removalChange: (expected: String, records: String)?
  ) throws -> (xml: String, model: AdjustmentModel) {
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
    let passthroughOnDisk = existingXML.map(XMPParser.parsePassthrough) ?? .empty
    let existingRemoval = try existingXML.flatMap {
      try RemovalXMPRecords.field(Data($0.utf8))
    }
    let canonicalRemovalName = "papp:InpaintRemovals"
    // Canonical serialization binds papp to Maple. A foreign namespace using
    // that spelling cannot become a Maple edit or be silently discarded.
    if existingRemoval?.name != canonicalRemovalName || existingRemoval?.propertyNamespaces != nil,
      passthroughOnDisk.unknownAttributes.contains(where: { $0.name == canonicalRemovalName })
    {
      throw RemovalError.invalid("Foreign removal attribute conflicts with Maple's XMP namespace")
    }
    if let existingRemoval, !existingRemoval.primary {
      throw RemovalError.invalid(
        "Removal records outside the primary XMP description cannot be rewritten safely")
    }
    if let removalChange {
      guard let rawURL else { throw RemovalError.invalid("Removal requires a local RAW") }
      let current = existingRemoval?.records ?? "[]"
      guard current == removalChange.expected else { throw RemovalError.saveConflict }
      // Clearing the stack must still refer to the same original. Verifying
      // only the empty target would lose this binding during undo/reset.
      try RemovalBridge.verifySource(records: current, rawURL: rawURL)
      try RemovalBridge.verifySource(records: removalChange.records, rawURL: rawURL)
      // A valid restored file need not have a durable publication receipt.
      // Redo/restore can bypass publish, so verify and sync every target asset
      // and its carrier under this writer lock before publishing XMP (#3940).
      try LocalRemovalAssetStore.synchronizeAssets(records: removalChange.records, rawURL: rawURL)
    }
    // Ordinary saves preserve the disk stack even when their incoming model
    // is stale. Only the verified CAS route above can change accepted pixels.
    var savedModel = model
    savedModel.inpaintRemovals = try (removalChange?.records ?? existingRemoval?.records).map {
      try RemovalRecords(json: $0)
    }
    // Explicit clearing uses the default (absent) representation so an undo
    // snapshot and a newly reopened model are equal, not nil versus empty.
    if removalChange != nil, savedModel.inpaintRemovals?.isEmpty == true {
      savedModel.inpaintRemovals = nil
    }
    let xml: String
    if let metadata, !metadata.isEmpty {
      xml = XMPSerializer.serialize(
        model: savedModel, culling: culling, metadata: metadata, passthrough: passthroughOnDisk)
    } else {
      xml = XMPSerializer.serialize(
        model: savedModel, culling: culling, passthrough: passthroughOnDisk)
    }
    return (xml, savedModel)
  }

  /// `adoption` publishes a merge the editor still has to adopt: until it
  /// confirms, the observed revision stays the document its model represents.
  func publishSidecarXML(
    _ xml: String, at destination: URL, durable: Bool, adoption: PendingAdoption? = nil,
    unchanged: Bool = false
  ) throws {
    let head = try WorkflowSidecarCore.headId(xmp: xml, variantId: variantId)
    if unchanged {
      try XMPSidecarFilePublication.confirmExisting(xml, at: destination)
    } else {
      try XMPSidecarFilePublication.publish(xml, at: destination, durable: durable)
    }
    observedSidecarXML = adoption?.represented ?? xml
    hasObservedSidecar = true
    lineageHeadID = head
    removalObservedRevision = try RemovalSidecarRevision(xml: xml)
    stagedAdoption = adoption.map { StagedAdoption(published: xml, document: $0.document) }
    if let adoption { reconciliationHub.publish(adoption.document) }
    try afterPublication?()
  }
}

// MARK: - XMPStoreError

public enum XMPStoreError: Error, LocalizedError {
  case encodingError
  case externalConflict(URL)
  case publishedContentMismatch(URL)

  public var errorDescription: String? {
    switch self {
    case .encodingError: return "XMP serialization produced non-UTF8 data"
    case .externalConflict(let url):
      return
        "Sidecar \(url.lastPathComponent) changed outside Maple. Maple did not overwrite it; restart Maple to load the newer version."
    case .publishedContentMismatch(let url):
      return "Sidecar \(url.lastPathComponent) no longer holds the bytes that were published"
    }
  }
}
