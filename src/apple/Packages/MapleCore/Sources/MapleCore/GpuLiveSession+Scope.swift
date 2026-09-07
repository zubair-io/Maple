// GpuLiveSession+Scope.swift
// MapleCore
//
// The scope-stats binding and unpack for the live present (#3272/#3277,
// snapshot #3251), split out of `GpuLiveSession.swift` for the file-size
// budget. The session owns one reused `MapleScopeStats` plus the two
// caller-owned buffers raw-ffi writes through (`scopeBins`, `scopeSnapshot`);
// both are rebound by pointer on every tick that asks for scope output.

import Foundation
import RawPipeline

extension GpuLiveSession {
  /// Bind `scope_out` to the session's own reused `MapleScopeStats` staging
  /// struct — with its bins and snapshot buffers wired in — for the duration
  /// of `body`, but only when the caller actually asked for scope output
  /// (`params.scope_enabled`, set by `makeGpuLiveParams` before this runs).
  /// A null `scope_out` is the "the host didn't ask for scope stats on this
  /// call" case raw-ffi's own `write_stats` / `write_snapshot` already treat
  /// as a silent no-op.
  func withScopeBound<R>(
    _ params: MapleGpuLiveParams,
    _ body: (MapleGpuLiveParams) -> R
  ) -> R {
    var p = params
    guard p.scope_enabled != 0 else { return body(p) }
    return scopeBins.withUnsafeMutableBufferPointer { binsBuf in
      scopeStats.bins_ptr = binsBuf.baseAddress
      scopeStats.bins_len = UInt32(binsBuf.count)
      return scopeSnapshot.withUnsafeMutableBufferPointer { snapBuf in
        scopeStats.snapshot_ptr = snapBuf.baseAddress
        scopeStats.snapshot_len = UInt32(snapBuf.count)
        return withUnsafeMutablePointer(to: &scopeStats) { sp in
          p.scope_out = sp
          return body(p)
        }
      }
    }
  }

  /// The sample the FFI just wrote, if it wrote a genuinely new one.
  /// One-tick-late by design (`live_session/scope.rs`'s own contract): only
  /// report a sample when `scopeStats.frame` actually moved since the last
  /// call — an unchanged frame means the FFI polled and found nothing new
  /// yet, not that this tick has no scope data at all.
  func takeScopeSample(enabled: Bool) -> ScopeSample? {
    guard enabled, scopeStats.frame != lastScopeFrame else { return nil }
    lastScopeFrame = scopeStats.frame
    return ScopeSample.unpack(
      bins: scopeBins, total: scopeStats.total, frame: scopeStats.frame,
      snapshot: ScopeSnapshot.unpack(scopeStats, from: scopeSnapshot))
  }
}
