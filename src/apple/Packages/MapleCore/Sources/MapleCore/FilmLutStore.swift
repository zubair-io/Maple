// FilmLutStore.swift — loads and decodes `.mlut` film-look assets for the
// Apple app (epic #2683, Task 10).
//
// The catalog's 100 `.mlut` files are bundled into the "Maple Exposure" app
// target as a folder reference (`resources/film-luts`, `Maple.xcodeproj/
// project.pbxproj`) rather than SwiftPM's `Bundle.module` — the film-look
// asset pack lives at repo-root `resources/film-luts/`, outside the
// `MapleCore` package's own `Sources/MapleCore` tree, so `init(bundle:)`
// defaults to `.main` (the app bundle the folder reference actually lands
// in) rather than `.module`. Tests inject their own bundle (a tiny fixture
// `.mlut` under the test target's resources).
//
// One-entry LRU: the session only ever has ONE active film look at a time
// (`AdjustmentModel.filmLook`), so caching the single most-recently-resolved
// id/lattice pair avoids re-reading + re-decoding the `.mlut` on every
// render call for the SAME look (a slider tick on `filmStrength`, or a
// refine/GPU-live re-present that re-reads the session's cached film state)
// while still being trivially correct on a look switch (the old entry is
// simply evicted).

import Foundation
import RawPipeline
import os

private let filmLutLog = Logger(subsystem: "app.justmaple.aperture", category: "film-lut-store")

/// Loads a film-look `.mlut` asset by catalog id and decodes it into the flat
/// `size³·3` f32 lattice `MapleGpuLiveParams.film_lut_*` /
/// `maple_render_file_with_film` expect. A `struct` (value semantics) whose
/// only mutable state — the one-entry LRU — lives in a small reference-typed
/// box, so `FilmLutStore` itself stays `Sendable`-friendly and cheap to pass
/// around (mirrors `PipelineRenderer`'s "no unsafe lifetime leaks" design,
/// not `AutoProfileLUT`'s process-wide actor — a film look has no per-image
/// fit cost to amortise across sessions, just a byte-parse worth caching
/// across repeated calls for the SAME id).
public struct FilmLutStore {
    /// One decoded lattice: the grid edge, the flat `size³·3` f32 data, and
    /// its FNV-1a(id) content-identity key (`MapleGpuLiveParams.film_lut_key`
    /// / `Task 8`'s `film_lut_key` — never 0, reserved for "none").
    private final class Cache {
        var id: String?
        var lattice: (data: [Float], size: Int, key: UInt32)?
    }

    private let bundle: Bundle
    private let cache = Cache()

    public init(bundle: Bundle = .main) {
        self.bundle = bundle
    }

    /// Resolve `id` to its decoded lattice, or `nil` when the id is empty,
    /// the `.mlut` asset is missing from the bundle, or the bytes fail to
    /// decode (malformed file) — every failure path logs and returns `nil`
    /// rather than throwing, matching `AutoProfileLUT`'s "render plain"
    /// fallback contract: a missing/broken look must never fail a render.
    ///
    /// Returns the cached lattice unchanged on a repeat call for the SAME
    /// `id` (the LRU hit) without touching disk or the FFI again.
    public func lattice(for id: String) -> (data: [Float], size: Int, key: UInt32)? {
        guard !id.isEmpty else { return nil }
        if cache.id == id, let hit = cache.lattice {
            return hit
        }
        guard let resolved = Self.load(id: id, bundle: bundle) else {
            // A miss must evict any stale entry for a DIFFERENT id — leaving
            // the old cache around would let a later call for the SAME
            // (still-missing) id spuriously read the old id's bytes back
            // out via the `cache.id == id` fast path above. Only reachable
            // if the caller passes two different missing ids in a row; the
            // common repeated-miss-on-one-id case is already correct
            // because `cache.id` never equals `id` on a fresh miss.
            cache.id = nil
            cache.lattice = nil
            return nil
        }
        cache.id = id
        cache.lattice = resolved
        return resolved
    }

    /// Decode `.mlut` bytes at `id` via the Task 8 FFI (grow-and-retry per
    /// the contract documented on `maple_film_lut_decode`): the catalog's
    /// baked grid is 33 nodes/axis (`33*33*33*3 = 107_811` floats), so a
    /// one-shot allocation at that size succeeds for every shipped look;
    /// a `-2` (undersized buffer) re-allocates at the FFI-reported size and
    /// retries once — decoding is pure byte-parsing, so the re-decode costs
    /// nothing material.
    private static func load(id: String, bundle: Bundle) -> (data: [Float], size: Int, key: UInt32)? {
        guard let url = bundle.url(forResource: id, withExtension: "mlut", subdirectory: "film-luts") else {
            filmLutLog.notice("FilmLutStore: no .mlut asset for id \(id, privacy: .public) — plain render")
            return nil
        }
        guard let bytes = try? Data(contentsOf: url) else {
            filmLutLog.error("FilmLutStore: failed to read \(url.path, privacy: .public)")
            return nil
        }

        var capacity = 33 * 33 * 33 * 3
        var (rc, lattice) = Self.decode(bytes: bytes, capacity: capacity)
        if rc == -2 {
            // The FFI's `maple_last_error` carries the required float count
            // for a `-2`, but re-deriving it from the message string would
            // be fragile; instead double the buffer and retry — grids
            // beyond the 33³ catalog default are not expected, so one
            // doubling comfortably covers any future larger bake.
            capacity *= 2
            (rc, lattice) = Self.decode(bytes: bytes, capacity: capacity)
        }
        guard rc > 0, let lattice else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown"
            filmLutLog.error("maple_film_lut_decode failed for \(id, privacy: .public): \(msg, privacy: .public)")
            return nil
        }
        let size = Int(rc)
        return (data: lattice, size: size, key: fnv1aHash(id))
    }

    /// One `maple_film_lut_decode` call at `capacity` floats. Returns the raw
    /// rc plus the (possibly oversized — trimmed by the caller via `rc`'s
    /// reported size) output buffer on success, `nil` lattice on any
    /// non-positive rc.
    private static func decode(bytes: Data, capacity: Int) -> (rc: Int32, lattice: [Float]?) {
        var out = [Float](repeating: 0, count: capacity)
        let rc: Int32 = bytes.withUnsafeBytes { buf -> Int32 in
            let base = buf.bindMemory(to: UInt8.self).baseAddress
            return out.withUnsafeMutableBufferPointer { obuf in
                maple_film_lut_decode(base, UInt(buf.count), obuf.baseAddress, UInt(capacity))
            }
        }
        guard rc > 0 else { return (rc, nil) }
        let n = Int(rc)
        let needed = n * n * n * 3
        guard needed <= out.count else { return (rc, nil) }
        return (rc, Array(out.prefix(needed)))
    }

    /// FNV-1a(id) — the content-identity key `MapleGpuLiveParams.film_lut_key`
    /// / `maple_render_file_with_film`'s peers fold into the GPU chain
    /// signature (Task 8's doc: "Task 10 uses the FNV-1a hash of the look's
    /// catalog id string"). `0` is reserved for "none" everywhere downstream,
    /// so a (astronomically unlikely) hash collision with 0 is nudged to 1 —
    /// the id is non-empty by the time this runs (`lattice(for:)` guards
    /// empty ids before reaching here), so 0 can only be that hash
    /// coincidence, never the "no look" sentinel misfiring.
    static func fnv1aHash(_ id: String) -> UInt32 {
        var hash: UInt32 = 0x811c_9dc5
        for byte in id.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x0100_0193
        }
        return hash == 0 ? 1 : hash
    }
}
