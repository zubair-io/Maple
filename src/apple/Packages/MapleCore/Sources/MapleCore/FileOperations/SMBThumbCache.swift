// SMBThumbCache.swift — on-share `.maple/thumbs/` cache reader/writer for
// SMB assets (#2690, follow-up to #2689's SMB browse-perf investigation).
//
// Today `SMBSource.thumb(for:)` always returns `nil`, so `ThumbnailLoader`'s
// sourceless branch falls straight to `bytesProvider` — pulling the ENTIRE
// RAW over the network and running a full Rust develop per thumbnail, per
// cold session. The share very likely already carries
// `.maple/thumbs/<sha256Prefix16(basename)>.avif` entries written by the
// Self Hosted indexer, Web Hosted, or a Mac browsing the same share via a
// Finder mount — the cross-layer contract in `MapleThumbCacheKey`/
// `MapleSidecarPaths`. `SMBThumbCache` does ONE transport read at that path
// before any fallback, and best-effort writes the fallback's render back to
// the same path so the next session (and every other Maple client on the
// share) hits.
//
// Routed through `SMBFileTransport` (#2631's relocate-engine seam), not a
// raw `SMB2Manager`, so tests substitute `FakeSMBTransport` instead of
// requiring a live SMB server — same reasoning as `SMBFileOperations`.
//
// Write-back mirrors `SMBIdCacheStorage.writeIdCacheFile` (#1995):
// temp-then-rename, because a dropped SMB connection mid-write must not
// leave a truncated/corrupt AVIF at the final path for another reader to
// observe. A write failure (read-only share, dropped connection, etc.)
// degrades SILENTLY — the caller already has the rendered bytes in hand
// from the fallback; only the cross-session cache entry is missing.

import Foundation

struct SMBThumbCache: Sendable {
    private let transport: SMBFileTransport

    init(transport: SMBFileTransport) {
        self.transport = transport
    }

    /// `<assetDir>/.maple/thumbs/<sha256Prefix16(basename)>.avif` — computed
    /// via `MapleSidecarPaths.thumbURL`, the single source of truth for this
    /// naming (never re-derived here). The share-relative asset path is
    /// wrapped in `URL(fileURLWithPath:)` purely for its lexical
    /// path-component logic — no filesystem access happens, an SMB path
    /// isn't a real local path — the same trick
    /// `SMBFileOperations.sidecarPath(for:)` already uses for SMB paths.
    static func onShareThumbPath(forAssetPath assetPath: String) -> String {
        MapleSidecarPaths.thumbURL(for: URL(fileURLWithPath: assetPath)).path
    }

    /// ONE transport read at the on-share thumb path. `nil` on a miss OR any
    /// transport error (missing `.maple/thumbs/`, permission denial,
    /// dropped connection) — `SMBSource.thumb(for:)`'s existing
    /// render-from-bytes fallback runs in every one of those cases, so a
    /// read failure must never surface as a thrown error.
    func read(forAssetPath assetPath: String) async -> Data? {
        try? await transport.readFile(atPath: Self.onShareThumbPath(forAssetPath: assetPath))
    }

    /// Best-effort write-back of a freshly rendered thumbnail, temp-then-
    /// rename. Never throws — a read-only share (or any other write
    /// failure) degrades silently to today's behavior: the caller already
    /// has `data` in hand from the render, so a missing on-share entry only
    /// costs the NEXT session a re-render, never this one a visible error.
    func write(_ data: Data, forAssetPath assetPath: String) async {
        let finalPath = Self.onShareThumbPath(forAssetPath: assetPath)
        let thumbDir = (finalPath as NSString).deletingLastPathComponent
        // Best-effort: the `.maple/thumbs/` directory usually already
        // exists (another client wrote it first); a genuinely-missing one
        // surfaces for real on the `write` call that follows.
        try? await transport.createDirectory(atPath: thumbDir)

        let tmpPath = (thumbDir as NSString)
            .appendingPathComponent(".\(UUID().uuidString).tmp.avif")
        do {
            try await transport.writeFile(data: data, toPath: tmpPath)
            // SMB2 rename (`moveItem`) is not guaranteed to overwrite an
            // existing destination (server-dependent `ReplaceIfExists`
            // semantics) — best-effort remove the previous file first so
            // the rename that follows lands cleanly; "didn't exist yet" is
            // the expected outcome on a first write and its failure is
            // swallowed. Mirrors `SMBIdCacheStorage.writeIdCacheFile`.
            try? await transport.removeItem(atPath: finalPath)
            try await transport.moveItem(atPath: tmpPath, toPath: finalPath)
        } catch {
            try? await transport.removeItem(atPath: tmpPath)
        }
    }
}
