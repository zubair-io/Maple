// ScopeSample.swift — Swift-side unpack of MapleScopeStats (core plan #3272)
// into the row-major grid MuiVectorscope's `bins` parameter consumes.

import Foundation

public struct ScopeSample: Sendable, Equatable {
    public let bins: [[UInt32]]
    public let total: UInt32
    public let frame: UInt64

    public static func unpack(bins flat: [UInt32], total: UInt32, frame: UInt64) -> ScopeSample {
        let n = 128
        var grid = [[UInt32]](repeating: [UInt32](repeating: 0, count: n), count: n)
        for row in 0..<n {
            let start = row * n
            grid[row] = Array(flat[start..<start + n])
        }
        return ScopeSample(bins: grid, total: total, frame: frame)
    }
}
