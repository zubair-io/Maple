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
public actor XMPSidecarStore {
    private let rawURL: URL
    private let sidecarURL: URL

    private var cached: (AdjustmentModel, CullingState)?
    private var pendingTask: Task<Void, Never>?
    private var pendingModel: AdjustmentModel?
    private var pendingCulling: CullingState?

    private var pendingMetadata: XmpMetadata? = nil

    private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
    private var nextSubscriberID: UInt64 = 0

    static let debounceInterval: Duration = .milliseconds(750)

    public init(rawURL: URL) {
        self.rawURL = rawURL
        self.sidecarURL = rawURL.deletingPathExtension().appendingPathExtension("xmp")
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
            return nil
        }
        let data = try Data(contentsOf: sidecarURL)
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

    /// The IPTC/EXIF metadata block currently persisted in the sidecar, or nil
    /// when none exists. Used to preserve metadata across model-only writes.
    private func existingMetadataOnDisk() -> XmpMetadata? {
        guard FileManager.default.fileExists(atPath: sidecarURL.path),
              let xml = try? String(contentsOf: sidecarURL, encoding: .utf8)
        else { return nil }
        let metadata = XMPParser.parseMetadata(xml)
        return metadata.isEmpty ? nil : metadata
    }

    private func readFromDisk() throws -> (AdjustmentModel, CullingState) {
        guard FileManager.default.fileExists(atPath: sidecarURL.path) else {
            return (.default, CullingState())
        }
        let data = try Data(contentsOf: sidecarURL)
        return try XMPParser.parse(data: data)
    }

    private func writePending() async {
        guard let model = pendingModel, let culling = pendingCulling else { return }
        pendingModel = nil
        pendingCulling = nil
        do {
            try writeAtomically(model: model, culling: culling)
        } catch {
            for subscriber in subscribers.values {
                subscriber.yield(error)
            }
        }
    }

    private func writeAtomically(model: AdjustmentModel, culling: CullingState) throws {
        // Non-destructive: a model/culling-only write must NOT drop an existing
        // IPTC/EXIF metadata block (e.g. one authored by the batch editor). Use
        // the pending metadata if this write carries one, otherwise preserve
        // whatever is already on disk. (parseMetadata of a no-metadata sidecar
        // returns an empty struct, which we treat as "no block".)
        let metadata = pendingMetadata ?? existingMetadataOnDisk()
        pendingMetadata = nil
        let xml: String
        if let metadata, !metadata.isEmpty {
            xml = XMPSerializer.serialize(model: model, culling: culling, metadata: metadata)
        } else {
            xml = XMPSerializer.serialize(model: model, culling: culling)
        }
        guard let data = xml.data(using: .utf8) else {
            throw XMPStoreError.encodingError
        }
        let tmpURL = sidecarURL.deletingLastPathComponent()
            .appendingPathComponent(".\(sidecarURL.lastPathComponent).tmp")
        try data.write(to: tmpURL, options: .atomic)
        // Atomic rename
        _ = try FileManager.default.replaceItemAt(sidecarURL, withItemAt: tmpURL)
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
