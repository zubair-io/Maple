// ComposedSource.swift — pair a metadata source with a bytes source.
//
// Per spec §09: on the LAN, the native app wants metadata and small previews
// from the Bun API (cheap, indexed) but the full RAW bytes directly from SMB
// (latency-free, no server round-trip). ComposedSource routes each
// `ImageSource` method to whichever child provides the best answer, per the
// §09 routing table:
//
//     images, search     -> metadata
//     thumb, preview     -> metadata (server's cache wins)
//     rawBytes           -> bytes (SMB fast path)
//     writeXMP           -> bytes (atomic rename over SMB), falling back to
//                           metadata when the bytes source is read-only
//
// `Coverage` exists so future code can widen this beyond the one-folder-
// shared-between-sources case; for now we only support `.same(folder:)`.

import Foundation

// MARK: - ComposedSource

public actor ComposedSource: ImageSource {

    public enum Coverage: Sendable {
        /// Both sources describe the same folder — SMB mounts the same path
        /// the Bun API has indexed. Routing is unconditional.
        case same(folder: String)
    }

    private let metadata: any ImageSource
    private let bytes: any ImageSource
    private let coverage: Coverage

    public init(metadata: any ImageSource,
                bytes: any ImageSource,
                coverage: Coverage) {
        self.metadata = metadata
        self.bytes = bytes
        self.coverage = coverage
    }

    // MARK: ImageSource

    public func images() async throws -> [ImageRef] {
        try await metadata.images()
    }

    public func thumb(for ref: ImageRef) async throws -> Data? {
        try await metadata.thumb(for: ref)
    }

    public func preview(for ref: ImageRef) async throws -> Data? {
        try await metadata.preview(for: ref)
    }

    public func rawBytes(for ref: ImageRef) async throws -> Data {
        try await bytes.rawBytes(for: ref)
    }

    public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        do {
            try await bytes.writeXMP(sidecar, for: ref)
        } catch ImageSourceError.readOnly {
            // Fall back to metadata (API PUT) when the bytes channel refuses.
            try await metadata.writeXMP(sidecar, for: ref)
        }
    }

    public func search(_ query: SearchQuery) async throws -> [ImageRef]? {
        try await metadata.search(query)
    }
}
