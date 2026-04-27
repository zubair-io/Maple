// PanoramaSource.swift — resolves ImageRef inputs to raw bytes (T5.3).
//
// Bridges the generic `ImageSource` protocol to the panorama pipeline by
// fetching full-resolution RAW bytes for each input asset. DCP bytes are
// intentionally absent for now; the slot is reserved in the tuple type for
// a P5+ per-frame DCP override.
//
// Adaptation notes vs. task brief:
//   - Protocol is `ImageSource` (not `LibrarySource`) — the actual Swift name.
//   - Asset type is `ImageRef` (not `ImageAsset`) — the actual Swift name.
//   - Byte fetch is `rawBytes(for:)` (not `fullImageData(for:)`) — the actual
//     method defined by `ImageSource`.

import Foundation

// MARK: - PanoramaSourceError

public enum PanoramaSourceError: LocalizedError, Sendable {
    case loadFailed(String, underlying: Error)

    public var errorDescription: String? {
        switch self {
        case .loadFailed(let name, let err):
            return "Failed to load '\(name)' for panorama: \(err.localizedDescription)"
        }
    }
}

// MARK: - PanoramaSource

/// Resolves panorama input assets to raw bytes + optional DCP bytes.
///
/// Wraps any `ImageSource`-conforming actor and loads full-resolution RAW
/// bytes for each `ImageRef`. Sequential loading is used for the MVP —
/// parallel loading via `TaskGroup` is a follow-up optimisation.
///
/// DCP bytes are returned as `nil` for now; the tuple slot is kept in the
/// API so future callers can plumb per-frame DCP overrides without a
/// breaking change.
public actor PanoramaSource {
    private let library: any ImageSource

    public init(library: any ImageSource) {
        self.library = library
    }

    /// Load the original-pixel bytes for each asset, in order.
    ///
    /// Returns `[(imageBytes, dcpBytes?)]`. `dcpBytes` is always `nil`
    /// today; per-frame DCP override is deferred to P5+.
    public func loadAll(assets: [ImageRef]) async throws -> [(Data, Data?)] {
        var out: [(Data, Data?)] = []
        out.reserveCapacity(assets.count)
        for asset in assets {
            let bytes = try await loadOne(asset)
            out.append((bytes, nil))
        }
        return out
    }

    // MARK: - Private

    private func loadOne(_ asset: ImageRef) async throws -> Data {
        do {
            return try await library.rawBytes(for: asset)
        } catch {
            throw PanoramaSourceError.loadFailed(asset.displayName, underlying: error)
        }
    }
}
