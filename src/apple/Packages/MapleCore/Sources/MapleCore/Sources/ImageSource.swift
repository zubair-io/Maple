// ImageSource.swift — unified source protocol per spec § 09.
//
// Four concrete implementations (FilesystemSource, SMBSource, PhotoKitSource,
// CloudSource) share this surface so the Browse and EditSession layers
// can treat any photo origin uniformly. A fifth type, ComposedSource, pairs a
// metadata source (typically CloudSource) with a bytes source (SMB on the
// LAN) — see ComposedSource.swift.
//
// Notes:
//   - Every concrete source is an `actor` so the protocol inherits `Actor`.
//     Method calls are implicitly `async` from the outside.
//   - `search(_:)` returns `nil` for sources that can't search (filesystem-
//     level ones). Server-backed sources may return `.some`.
//   - `Sidecar` is a thin bundling of `(AdjustmentModel, CullingState)` — the
//     same pair XMPSidecarStore already reads and writes — so we don't
//     introduce a parallel schema.

import Foundation

// MARK: - ImageRef

/// Stable reference to an asset across sources.
///
/// `id` is the BLAKE3 `maple:id` hex string when known (Bun API, Indexer-
/// populated `.maple/` cache). For raw-only filesystem/SMB/PhotoKit sources
/// that haven't been hashed yet, an opaque source-scoped string is used until
/// the id is computed; consumers should treat it as an opaque primary key.
public struct ImageRef: Sendable, Hashable, Identifiable, Codable {
    /// Stable identifier. Prefer the BLAKE3 `maple:id` hex when available.
    public let id: String

    /// Display name (file basename, PHAsset localIdentifier, etc).
    public let displayName: String

    /// Filesystem or SMB URL, when the source is file-shaped. `nil` for
    /// PhotoKit- and API-backed sources where the notion of a URL is
    /// synthetic.
    public let url: URL?

    /// Bookmark-resolved ancestor URL that grants security-scoped access to
    /// `url`. Populated by filesystem-shaped sources (FilesystemSource) so
    /// downstream consumers (ImageEditPipeline, ThumbnailLoader) can wrap
    /// their Rust FFI calls in a scope-claim bracket that actually succeeds.
    /// `nil` for sourceless adapters (PhotoKit, SelfHosted).
    public let scopeParentURL: URL?

    public init(id: String, displayName: String, url: URL? = nil, scopeParentURL: URL? = nil) {
        self.id = id
        self.displayName = displayName
        self.url = url
        self.scopeParentURL = scopeParentURL
    }
}

// MARK: - Sidecar

/// What an ImageSource writes when persisting per-image state. Mirrors the
/// pair `XMPSidecarStore` already round-trips to `.xmp` files.
public struct Sidecar: Sendable, Equatable, Hashable {
    public var model: AdjustmentModel
    public var culling: CullingState

    public init(model: AdjustmentModel, culling: CullingState) {
        self.model = model
        self.culling = culling
    }
}

// MARK: - SearchQuery

/// Minimal structured search envelope. Mirrors the `GET /api/search`
/// parameters from spec § 07 (q/filter/near). Free-text `q` is the only
/// required field; the rest are refinements the server understands.
public struct SearchQuery: Sendable, Equatable, Hashable, Codable {
    /// Free-text query (matches EXIF camera, keywords, place names, etc).
    public var q: String
    /// Server-side filter expression (opaque; `rating:>=4`, `flag:pick`, …).
    public var filter: String?
    /// "lat,lon,radius_km" for geo search. Opaque on the client.
    public var near: String?
    public var limit: Int?
    public var offset: Int?

    public init(q: String, filter: String? = nil, near: String? = nil,
                limit: Int? = nil, offset: Int? = nil) {
        self.q = q
        self.filter = filter
        self.near = near
        self.limit = limit
        self.offset = offset
    }
}

// MARK: - ImageSource

/// Unified source protocol. Every concrete implementation is an `actor` —
/// calls are implicitly async from the caller's context.
public protocol ImageSource: Actor {
    /// Every asset the source can see, ordered by capture date descending
    /// (or filename when capture date is unavailable).
    func images() async throws -> [ImageRef]

    /// ~256 px thumbnail bytes (JPEG). Returns `nil` when the source has
    /// nothing to hand back yet (e.g. Indexer hasn't rendered `.maple/thumbs/`).
    func thumb(for ref: ImageRef) async throws -> Data?

    /// ~1600 px preview bytes (JPEG). Returns `nil` when not rendered yet.
    func preview(for ref: ImageRef) async throws -> Data?

    /// Full RAW bytes for the Rust decode pipeline.
    func rawBytes(for ref: ImageRef) async throws -> Data

    /// Persist a sidecar. Atomic on file sources (temp + rename); an API
    /// PUT on CloudSource. Throws if the source is read-only.
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws

    /// Structured/full-text search. Returns `nil` when the source cannot
    /// search at all (filesystem, SMB, PhotoKit without a local index);
    /// returns `.some([])` when it can search but found nothing.
    func search(_ query: SearchQuery) async throws -> [ImageRef]?
}

// MARK: - ImageSourceError

public enum ImageSourceError: Error, LocalizedError {
    case readOnly(String)
    case notFound(String)
    case unsupported(String)

    public var errorDescription: String? {
        switch self {
        case .readOnly(let s):    return "Source is read-only: \(s)"
        case .notFound(let s):    return "Not found: \(s)"
        case .unsupported(let s): return "Operation not supported by this source: \(s)"
        }
    }
}
