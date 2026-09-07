// MaskRemapRasterCache.swift — bitmap-mask rasters re-expressed in a render
// buffer's space (#355).
//
// A `.bitmap` layer's weight is a raster sampled in full-frame normalized
// coordinates (`raw-core` `MaskRaster::sample`), so unlike a linear or
// radial mask it cannot be re-expressed for a cropped or windowed buffer by
// rewriting parameters (`MaskRemap`). What CAN be done exactly-enough is to
// resample the raster through the buffer→frame affine into a NEW raster
// whose own normalized space IS the buffer's, register that with the
// process-wide registry (`MaskRasterRegistry`), and hand the chain its id.
//
// `resample` is the pure half. This cache is the bookkeeping half: one
// derived id per `(source digest, affine)`, LRU-bounded, every evicted or
// abandoned id released back to the registry. Session-scoped (one per
// `EditSession`); the derived digest folds the affine in so two sessions
// never collide on a registry digest. Tabulated in `docs/caching.md` § Apple.

import Foundation

public final class MaskRemapRasterCache: @unchecked Sendable {
    public typealias Raster = (width: Int, height: Int, bytes: [UInt8])

    public struct Key: Hashable, Sendable {
        public let digest: String
        public let affine: MaskAffine

        public init(digest: String, affine: MaskAffine) {
            self.digest = digest
            self.affine = affine
        }
    }

    /// A crop change re-expresses every bitmap layer once; a native-detail
    /// pan does it per settled viewport. Eight covers a stack of several
    /// person masks across a couple of recent windows without holding a
    /// pan history of full rasters alive.
    public static let capacity = 8

    /// Longest edge a derived raster is ever built at. Source rasters come
    /// from a 1024 px-long-edge segmentation (`PersonSkinMaskService`), so a
    /// window can only ever want a FRACTION of that; the ceiling is a guard
    /// against a degenerate affine, not a working limit.
    static let maxDerivedEdge = 2048

    private let lock = NSLock()
    private var ids: [Key: UInt32] = [:]
    /// Most-recently-used LAST.
    private var order: [Key] = []
    private let release: @Sendable (UInt32) -> Void

    /// `release` is what an evicted id goes through — the registry in
    /// production, a recorder in tests.
    public init(release: @escaping @Sendable (UInt32) -> Void = { MaskRasterRegistry.release($0) }) {
        self.release = release
    }

    deinit {
        ids.values.forEach(release)
    }

    /// The derived raster id for `key`, refreshing its recency; `nil` on a miss.
    public func id(for key: Key) -> UInt32? {
        lock.lock()
        defer { lock.unlock() }
        guard let id = ids[key] else { return nil }
        order.removeAll { $0 == key }
        order.append(key)
        return id
    }

    /// Record `id` for `key`, releasing the least-recently-used entry once
    /// the cache is over capacity. A second insert for the SAME key (two
    /// misses racing across an `await`) keeps the first id and releases the
    /// newcomer, so no registered raster is ever orphaned.
    public func insert(_ id: UInt32, for key: Key) {
        lock.lock()
        defer { lock.unlock() }
        if ids[key] != nil {
            release(id)
            return
        }
        ids[key] = id
        order.append(key)
        while order.count > Self.capacity {
            let stale = order.removeFirst()
            if let evicted = ids.removeValue(forKey: stale) { release(evicted) }
        }
    }

    /// Number of derived ids currently held — test visibility only.
    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return ids.count
    }

    /// The registry digest for a derived raster: 16 lowercase hex chars
    /// (the registry's required shape), FNV-1a over the source digest and
    /// the affine's six coefficients, so distinct crops of one raster get
    /// distinct registry identities and the same crop reproduces the same.
    public static func derivedDigest(for key: Key) -> String {
        let m = key.affine
        let raw = "\(key.digest)|\(m.a)|\(m.b)|\(m.c)|\(m.d)|\(m.tx)|\(m.ty)"
        let digest = raw.utf8.reduce(UInt64(0xcbf2_9ce4_8422_2325)) { h, b in
            (h ^ UInt64(b)) &* 0x0000_0100_0000_01b3
        }
        return String(format: "%016llx", digest)
    }

    /// The size a derived raster is built at for `affine`: the source
    /// resolution scaled by how much of the frame each buffer axis spans
    /// (the affine's column lengths), so texel density matches the source
    /// where the buffer covers it, floored at 2 and capped at
    /// `maxDerivedEdge`.
    static func derivedSize(source: (width: Int, height: Int), through affine: MaskAffine) -> (width: Int, height: Int) {
        let spanX = (affine.a * affine.a + affine.b * affine.b).squareRoot()
        let spanY = (affine.c * affine.c + affine.d * affine.d).squareRoot()
        let clamp: (Double) -> Int = { v in
            v.isFinite ? min(max(Int(v.rounded()), 2), maxDerivedEdge) : 2
        }
        return (clamp(Double(source.width) * spanX), clamp(Double(source.height) * spanY))
    }

    /// `source` resampled through `affine`: derived texel `(i, j)` at
    /// buffer-normalized `(i / (w′ − 1), j / (h′ − 1))` holds the source's
    /// bilinear sample (`MaskWeight.sample`, raw-core's rule) at the
    /// full-frame point the affine maps it to — so the chain sampling the
    /// derived raster over the buffer reads the weight the CPU refine reads
    /// over the frame. A point the affine sends outside the frame (a
    /// straightened crop's empty corner) clamps to the edge texel, exactly
    /// as raw-core clamps an out-of-range normalized coordinate.
    public static func resample(_ source: Raster, through affine: MaskAffine) -> Raster {
        let size = derivedSize(source: (source.width, source.height), through: affine)
        let invW = 1 / Double(size.width - 1)
        let invH = 1 / Double(size.height - 1)
        var out = [UInt8](repeating: 0, count: size.width * size.height)
        for j in 0..<size.height {
            let v = Double(j) * invH
            for i in 0..<size.width {
                let p = affine.apply(MaskPoint(x: Double(i) * invW, y: v))
                let w = MaskWeight.sample(
                    width: source.width, height: source.height, bytes: source.bytes, x: p.x, y: p.y)
                out[j * size.width + i] = UInt8((w * 255).rounded())
            }
        }
        return (size.width, size.height, out)
    }
}
