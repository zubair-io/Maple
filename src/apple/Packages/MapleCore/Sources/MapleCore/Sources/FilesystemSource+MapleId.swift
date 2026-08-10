// FilesystemSource+MapleId.swift — maple_id derivation (#1995), split out
// of `FilesystemSource.swift` to stay clear of the 570-line headroom
// warning (`tools/check-budget-headroom.sh`) once the #2656 external-rename
// reconciliation wiring landed there. Pure extraction — no behavior change.

import Foundation

extension FilesystemSource {

    /// Resolve a maple_id for `asset`, consulting the folder's id-cache
    /// first (`MapleIdCacheStore.lookup`) and only re-deriving (then
    /// persisting) on a cache miss or a stale entry (size/mtime mismatch —
    /// the file was replaced at this path since the id was last computed).
    /// Returns `nil` when the file's attributes can't be read or derivation
    /// itself fails; `images()` falls back to the file path in that case.
    func mapleId(for asset: FileAsset) async -> String? {
        guard let idCache else { return nil }
        // `FileManager.attributesOfItem(atPath:)`, NOT `URL.resourceValues
        // (forKeys:)` — `URL` caches fetched resource values on the URL
        // value itself, so re-querying the SAME `FileAsset.url` (stored once
        // in `_assets`, reused across every `images()` call) after the file
        // changed on disk can silently return the FIRST call's stale
        // snapshot instead of a fresh stat(). `attributesOfItem(atPath:)`
        // has no such cache — every call is a real stat(2).
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: asset.url.path),
              let size = (attrs[.size] as? NSNumber)?.int64Value,
              let modDate = attrs[.modificationDate] as? Date
        else { return nil }

        let sizeI64 = size
        let mtime = modDate.timeIntervalSince1970
        // Non-recursive listing (`_index()`) means every asset's filename is
        // already a stable, unambiguous key within this folder — no need
        // for the full absolute path.
        let cacheKey = asset.url.lastPathComponent

        if let cached = await idCache.lookup(path: cacheKey, size: sizeI64, mtime: mtime) {
            return cached
        }
        guard let derived = await deriveMapleId(for: asset, filesize: sizeI64) else { return nil }
        await idCache.record(path: cacheKey, mapleId: derived, size: sizeI64, mtime: mtime)
        return derived
    }

    /// Derive a maple_id from scratch: read the first 64 KB + raw EXIF
    /// capture-date strings for the primary-form attempt, and hand a
    /// chunked `FileHandle` reader to `MapleIdDerivation.derive` for the
    /// fallback-form path so a large RAW is never held in memory as one
    /// buffer.
    private func deriveMapleId(for asset: FileAsset, filesize: Int64) async -> String? {
        guard let handle = try? FileHandle(forReadingFrom: asset.url) else { return nil }
        defer { try? handle.close() }

        let headBytes = (try? handle.read(upToCount: Self.mapleIdHeadByteCount)) ?? Data()
        let dates = ImageMetadataReader.readRawCaptureDateStrings(from: asset.url)
        // Rewind — the head read above consumed the handle's offset, and
        // the fallback-form path (if reached) needs the WHOLE file from
        // byte 0, head bytes included. A silently-swallowed seek failure
        // here would corrupt the fallback-form hash (missing its first 64
        // KB) without any signal, so this checks explicitly rather than
        // `try?`-and-proceed.
        do {
            try handle.seek(toOffset: 0)
        } catch {
            return nil
        }

        // `try` (not `try?`) inside the closure: a transient
        // `FileHandle.read` error must reach `derive`'s `rethrows`
        // propagation, not collapse to empty `Data` — which `derive`'s loop
        // reads as EOF, silently hashing only a prefix of the file into a
        // wrong fallback-form id. `derive`'s own `try?` at this call site
        // catches that (and any other) thrown error and collapses it to
        // `nil`, matching this function's established fail-safe-to-nil
        // contract (mirrors `SMBSource.deriveMapleId`'s identical
        // throw-then-`try?` shape for the same reason).
        return try? await MapleIdDerivation.derive(
            headBytes: headBytes,
            exifDateTimeOriginal: dates.dateTimeOriginal,
            exifCreateDate: dates.createDate,
            filesize: UInt64(filesize),
            nextChunk: {
                try handle.read(upToCount: Self.fallbackHashChunkSize) ?? Data()
            }
        )
    }

    /// First 64 KB of a file — the bound the primary-form head hash reads.
    /// Matches `raw_core::SHA1_HEAD_BYTES` (`id.rs`); duplicated as a literal
    /// rather than threaded across the FFI boundary for a single integer —
    /// `MapleId.primary` ignores anything past this bound regardless of how
    /// much the caller hands it, so reading more here would just waste I/O.
    fileprivate static let mapleIdHeadByteCount = 64 * 1024
}
