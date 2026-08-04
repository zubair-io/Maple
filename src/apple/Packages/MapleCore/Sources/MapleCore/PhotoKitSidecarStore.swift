// PhotoKitSidecarStore.swift — SidecarStoreProtocol conformer for
// PhotoKit-provenance assets (#2555).
//
// Mirrors XMPSidecarStore's debounced-write shape (same 750ms coalescing,
// same load/loadIfPresent/update/flush/errors surface) but persists into
// AppSupportSidecarStore (MapleBackup) — a file-per-`phassetLocalId` store —
// instead of writing next to a filesystem URL. PhotoKit assets have no
// stable on-disk path to place a `.xmp` beside.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §11 —
// "An XMPSidecarStore-shaped wrapper points EditSession at this path, so
// the rest of the edit pipeline doesn't know or care that the source is
// PhotoKit." This is that wrapper. Once EditSession is constructed with an
// instance of this as its `remoteSidecarStore` for `.photoKit`-provenance
// assets, a slider move or a culling-flag change lands in
// AppSupportSidecarStore — the same store BackupEngine's
// `uploadCompanionsBestEffort` already reads via
// `sidecars.read(phassetLocalId:)` to prefer a real local edit over the
// synthetic Apple-metadata XMP it derives from PHAsset state.
//
// Serialization mirrors PhotoKitSource.writeXMP / readXMP (same
// XMPSerializer / XMPParser calls, same AppSupportSidecarStore back end).
// This lives as its own SidecarStoreProtocol conformer rather than routing
// through the PhotoKitSource actor for two reasons: `loadIfPresent()` needs
// to distinguish "no sidecar written yet" (seed from as-shot WB) from
// "sidecar exists with default-valued content" — PhotoKitSource.readXMP
// collapses both to defaults, which is right for its own callers but wrong
// for EditSession's hydration gate — and EditSession has no reason to hold
// a full browsing actor (PHFetchResult, change-observer subscription) just
// to persist a sidecar.

import Foundation
import MapleBackup

// MARK: - PhotoKitSidecarStore

public actor PhotoKitSidecarStore: SidecarStoreProtocol {
    private let phassetLocalId: String
    private let sidecars: AppSupportSidecarStore

    private var cached: (AdjustmentModel, CullingState)?
    private var pendingTask: Task<Void, Never>?
    private var pendingModel: AdjustmentModel?
    private var pendingCulling: CullingState?

    private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
    private var nextSubscriberID: UInt64 = 0

    static let debounceInterval: Duration = .milliseconds(750)

    public init(phassetLocalId: String, sidecars: AppSupportSidecarStore) {
        self.phassetLocalId = phassetLocalId
        self.sidecars = sidecars
    }

    /// Convenience initializer that resolves the default App Support root
    /// (`AppSupportSidecarStore.defaultRoot()`). Throws under the same
    /// condition `PhotoKitSource.init()` does — an unavailable Application
    /// Support directory — so callers should handle failure the same way
    /// they already handle `PhotoKitSource()` failing (surface a load
    /// error, or fall back to a session-local `EditSession`), rather than
    /// crashing.
    public init(phassetLocalId: String) throws {
        self.init(
            phassetLocalId: phassetLocalId,
            sidecars: AppSupportSidecarStore(root: try AppSupportSidecarStore.defaultRoot()))
    }

    /// Load current model+culling, or defaults if no sidecar exists yet.
    public func load() async throws -> (AdjustmentModel, CullingState) {
        try await loadIfPresent() ?? (.default, CullingState())
    }

    /// Like `load()`, but returns `nil` when no sidecar has ever been
    /// written for this `phassetLocalId` — lets `EditSession` tell "fresh
    /// PhotoKit asset" apart from "user has saved edits" the same way it
    /// already does for `XMPSidecarStore` / `CloudSidecarStore`.
    public func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
        if let cached { return cached }
        guard let xml = try sidecars.read(phassetLocalId: phassetLocalId),
              let data = xml.data(using: .utf8) else {
            return nil
        }
        let result = try XMPParser.parse(data: data)
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
                try await Task.sleep(for: PhotoKitSidecarStore.debounceInterval)
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

    private func writePending() async {
        guard let model = pendingModel, let culling = pendingCulling else { return }
        pendingModel = nil
        pendingCulling = nil
        do {
            let xml = XMPSerializer.serialize(model: model, culling: culling)
            try sidecars.write(phassetLocalId: phassetLocalId, xmp: xml)
        } catch {
            for subscriber in subscribers.values {
                subscriber.yield(error)
            }
        }
    }
}
