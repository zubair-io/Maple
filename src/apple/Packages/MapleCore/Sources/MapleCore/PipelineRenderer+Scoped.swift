// PipelineRenderer+Scoped.swift
// MapleCore
//
// The scoped fused FFI entry (#3272/#3277) — chain + display encode +
// vectorscope histogram + RGB8 snapshot (#3251) in one Rust call — moved out
// of `PipelineRenderer.swift` for the file-size budget. `withChainPointers`
// stays in the parent file (internal so this sibling can reach it).

import Foundation
import RawPipeline

extension PipelineRenderer {
  /// Sibling of `applyChainAndEncodeDisplay` that ALSO computes a 128×128
  /// vectorscope histogram over the encoded output and a downsampled RGB8
  /// snapshot of it (#3251), via
  /// `maple_apply_chain_and_encode_display_scoped_f32` (core plan
  /// #3272, apple plan #3277). Used by the CPU / non-GPU-live scope
  /// producer (`EditSession+ScopeCpu.swift`) — the GPU-live path gets its
  /// scope stats from `GpuLiveSession.present` instead. `scopeLayer`
  /// selects which local-adjustment layer the histogram weighs (`-1` =
  /// whole image; the snapshot is always the whole frame). Discards the
  /// re-encoded display bytes the FFI also writes to its required out
  /// buffer — this caller only wants the stats — otherwise identical
  /// contract to `applyChainAndEncodeDisplay`.
  ///
  /// Returns the already-unpacked `ScopeSample` rather than the raw
  /// `MapleScopeStats`: that C struct's `bins` and `snapshot` are
  /// caller-owned `(ptr, len)` pairs (#3277 — a 128×128 fixed C array
  /// can't import into Swift at all), bound here to buffers local to this
  /// call, so handing the struct back to the caller would leave the
  /// pointers dangling the moment this function returns.
  public static func applyChainAndEncodeDisplayScoped(
    inputBytes: Data,
    width: Int,
    height: Int,
    params: MapleAdjustmentParams,
    scopeLayer: Int32,
    noiseProfile: [Float]? = nil,
    localAdjustments: [LocalAdjustment] = []
  ) throws -> ScopeSample {
    guard width > 0, height > 0 else {
      throw PipelineError.renderFailed(
        code: 2,
        message: "applyChainAndEncodeDisplayScoped: zero dimension width=\(width) height=\(height)"
      )
    }
    let lanes = width * height * 4
    let expectedBytes = lanes * MemoryLayout<Float>.size
    guard inputBytes.count == expectedBytes else {
      throw PipelineError.renderFailed(
        code: 9,
        message:
          "applyChainAndEncodeDisplayScoped: input \(inputBytes.count) bytes != expected \(expectedBytes)"
      )
    }
    var output = Data(count: expectedBytes)
    var stats = MapleScopeStats()
    var bins = [UInt32](repeating: 0, count: 16384)
    var snapshot = [UInt8](repeating: 0, count: ScopeSnapshot.bufferByteCount)
    let rc: Int32 = try withChainPointers(
      params, noiseProfile: noiseProfile, localAdjustments: localAdjustments
    ) { bound in
      var p = bound
      return try bins.withUnsafeMutableBufferPointer { binsBuf -> Int32 in
        stats.bins_ptr = binsBuf.baseAddress
        stats.bins_len = UInt32(binsBuf.count)
        return try snapshot.withUnsafeMutableBufferPointer { snapBuf -> Int32 in
          stats.snapshot_ptr = snapBuf.baseAddress
          stats.snapshot_len = UInt32(snapBuf.count)
          return try output.withUnsafeMutableBytes { outBuf -> Int32 in
            let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
            return inputBytes.withUnsafeBytes { inBuf -> Int32 in
              let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
              return withUnsafeMutablePointer(to: &stats) { statsPtr in
                maple_apply_chain_and_encode_display_scoped_f32(
                  inPtr, UInt32(width), UInt32(height),
                  &p,
                  scopeLayer,
                  statsPtr,
                  outPtr
                )
              }
            }
          }
        }
      }
    }
    guard rc == 0 else {
      let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
      throw PipelineError.renderFailed(code: Int(rc), message: msg)
    }
    return ScopeSample.unpack(
      bins: bins, total: stats.total, frame: stats.frame,
      snapshot: ScopeSnapshot.unpack(stats, from: snapshot))
  }
}
