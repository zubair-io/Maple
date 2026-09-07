// ScopeSample.swift — Swift-side unpack of MapleScopeStats (core plan #3272)
// into the row-major grid MuiVectorscope's `bins` parameter consumes, plus
// the downsampled RGB snapshot of the same frame (#3251) that the waveform /
// parade / histogram reductions read (`ScopePanelSample`).

import Foundation
import RawPipeline

/// The downsampled, display-encoded RGB8 snapshot of a presented frame — the
/// Apple twin of the web render worker's `readbackScopeSnapshot`: packed
/// row-major `3 × width × height` bytes, long edge clamped to `maxDim`.
public struct ScopeSnapshot: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let rgb: [UInt8]

    public init(width: Int, height: Int, rgb: [UInt8]) {
        self.width = width
        self.height = height
        self.rgb = rgb
    }

    /// Long-edge clamp raw-ffi applies (`MAPLE_SCOPE_SNAPSHOT_MAX_DIM`, the
    /// web worker's `SCOPE_READBACK_MAX_DIM`).
    public static let maxDim = Int(MAPLE_SCOPE_SNAPSHOT_MAX_DIM)

    /// Bytes a host-owned `snapshot_ptr` buffer must hold to receive any
    /// snapshot — raw-ffi skips the copy (and reports `0 × 0`) otherwise.
    public static let bufferByteCount = maxDim * maxDim * 3

    /// The snapshot `stats` describes, copied out of the host buffer raw-ffi
    /// wrote into. `nil` when no bytes landed (`0 × 0` dims — see
    /// `MapleScopeStats`'s own doc) or the buffer cannot hold the claimed
    /// dims, so a non-nil snapshot always has `3 × width × height` bytes.
    static func unpack(_ stats: MapleScopeStats, from buffer: [UInt8]) -> ScopeSnapshot? {
        let width = Int(stats.snapshot_width)
        let height = Int(stats.snapshot_height)
        let count = width * height * 3
        guard width > 0, height > 0, count <= buffer.count else { return nil }
        return ScopeSnapshot(width: width, height: height, rgb: Array(buffer[0..<count]))
    }
}

public struct ScopeSample: Sendable, Equatable {
    public let bins: [[UInt32]]
    public let total: UInt32
    public let frame: UInt64
    /// The same frame, downsampled (#3251) — `nil` only when the producer
    /// had no snapshot buffer bound (raw-ffi always writes both otherwise).
    public let snapshot: ScopeSnapshot?

    public init(bins: [[UInt32]], total: UInt32, frame: UInt64, snapshot: ScopeSnapshot? = nil) {
        self.bins = bins
        self.total = total
        self.frame = frame
        self.snapshot = snapshot
    }

    public static func unpack(
        bins flat: [UInt32], total: UInt32, frame: UInt64, snapshot: ScopeSnapshot? = nil
    ) -> ScopeSample {
        let n = 128
        var grid = [[UInt32]](repeating: [UInt32](repeating: 0, count: n), count: n)
        for row in 0..<n {
            let start = row * n
            grid[row] = Array(flat[start..<start + n])
        }
        return ScopeSample(bins: grid, total: total, frame: frame, snapshot: snapshot)
    }
}
