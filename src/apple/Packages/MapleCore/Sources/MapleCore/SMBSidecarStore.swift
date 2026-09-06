// SMBSidecarStore.swift — SidecarStoreProtocol conformer for SMB-provenance
// assets (#2674).
//
// Root cause this fixes: `EditSession` never wired ANY `SidecarStoreProtocol`
// for SMB-sourced assets — no `thumbnailProvenance` tag was set for them
// (`BrowseViewModel.loadSource`'s sourceless branch) and
// `AppShell+FolderActions.ensureSession`'s `nil`-provenance fallback only
// ever matches `.cloudLibrary` selections, which SMB browsing never sets
// (it sets `.smbShare`). So `EditSession.init` fell to its
// `sidecarStore = nil` branch and every slider/culling edit on an
// SMB-sourced photo was session-local and silently lost on teardown, even
// though `SMBSource.writeXMP`/`.writeSidecar` — the real, working,
// retry-over-AMSMB2 write path — worked fine in isolation.
//
// Mirrors `XMPSidecarStore`'s / `CloudSidecarStore`'s debounced-write shape
// (same 750ms coalescing, same load/loadIfPresent/update/flush/errors
// surface) but persists through `SMBSource.writeSidecarData`/
// `.readSidecarData` — the raw-bytes I/O primitives added alongside this
// file — instead of a local file or an HTTP PUT.
//
// Passthrough preservation (#2233) follows `CloudSidecarStore`'s pattern,
// not `XMPSidecarStore`'s: SMB has no cheap "read what's on disk right
// before this write" the way a local file does (every read is a network
// round trip), so the passthrough bucket is captured once on `load()` and
// held for the store's lifetime, then re-emitted on every write — same
// trade-off Cloud already makes for the same reason.
//
// Ownership: holds the CONNECTED `SMBSource` actor the browse session
// already has (`ensureSession` passes `browseVM.currentSource as? SMBSource`)
// rather than opening its own connection. `SMBSource.connect(credentials:)`
// re-walks the entire share (`listRAWFiles`) as part of connecting — paying
// that cost again per debounced sidecar write, for every visible grid cell,
// would be wasteful and would hammer the NAS; riding the one live
// connection the browse session already paid for is the same trade-off
// `XMPSidecarStore` makes implicitly (one already-open filesystem) and
// `CloudSidecarStore` makes explicitly (one already-authenticated HTTP
// client per session).

import Foundation

// MARK: - SMBSidecarStore

public actor SMBSidecarStore: SidecarStoreProtocol {
  private let source: SMBSource
  private let ref: ImageRef

  private var cached: (AdjustmentModel, CullingState)?

  /// Fields the SMB sidecar carried that Maple does not model (#2233).
  /// Captured on `load()` and held for the store's lifetime — see the
  /// file header for why this can't re-read from a cheap local disk the
  /// way `XMPSidecarStore` does.
  private var cachedPassthrough: XMPPassthrough = .empty
  private var cachedMetadata = XmpMetadata()

  private var pendingTask: Task<Void, Never>?
  private var writeTail: Task<Void, Error>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?

  private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
  private var nextSubscriberID: UInt64 = 0

  static let debounceInterval: Duration = .milliseconds(750)

  public init(source: SMBSource, ref: ImageRef) {
    self.source = source
    self.ref = ref
  }

  /// Load current model+culling, or defaults if no sidecar exists yet.
  public func load() async throws -> (AdjustmentModel, CullingState) {
    try await loadIfPresent() ?? (.default, CullingState())
  }

  /// Like `load()`, but returns `nil` when no sidecar has ever been
  /// written for this asset — lets `EditSession` tell "fresh SMB asset"
  /// apart from "user has saved edits" the same way it already does for
  /// `XMPSidecarStore` / `CloudSidecarStore` / `PhotoKitSidecarStore`.
  public func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    if let cached { return cached }
    guard let data = try await source.readSidecarData(for: ref) else { return nil }
    let result = try XMPParser.parse(data: data)
    cached = result
    cachedPassthrough = XMPParser.parsePassthrough(data: data)
    cachedMetadata = XMPParser.parseMetadata(String(decoding: data, as: UTF8.self))
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
        try await Task.sleep(for: SMBSidecarStore.debounceInterval)
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

  // MARK: Private

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = nil
    pendingCulling = nil

    cached = (model, culling)
    try await persist(model: model, culling: culling)
  }

  private func persist(model: AdjustmentModel, culling: CullingState) async throws {
    // Actor reentrancy must not let an older network write finish after a
    // confirmed batch write. Each real write waits for its predecessor.
    let previous = writeTail
    let task = Task {
      _ = await previous?.result
      try await send(model: model, culling: culling)
    }
    writeTail = task
    try await task.value
  }

  private func send(model: AdjustmentModel, culling: CullingState) async throws {
    // Metadata can change independently of this editor session. Preserve
    // the current sidecar's foreign XML and IPTC fields at the write boundary.
    let existing = try await source.readSidecarData(for: ref)
    if let existing {
      _ = try XMPParser.parse(data: existing)
      cachedMetadata = XMPParser.parseMetadata(String(decoding: existing, as: UTF8.self))
      cachedPassthrough = XMPParser.parsePassthrough(data: existing)
    }
    let xml = XMPSerializer.serialize(
      model: model, culling: culling, metadata: cachedMetadata, passthrough: cachedPassthrough)
    guard let data = xml.data(using: .utf8) else {
      throw XMPStoreError.encodingError
    }
    try await source.writeSidecarData(data, for: ref)
  }

  private func writePending() async {
    guard let model = pendingModel, let culling = pendingCulling else { return }
    pendingModel = nil
    pendingCulling = nil
    do {
      try await persist(model: model, culling: culling)
    } catch {
      for subscriber in subscribers.values {
        subscriber.yield(error)
      }
    }
  }
}
