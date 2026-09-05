// GpuLiveSession+Flatten.swift
// MapleCore
//
// The two allocation-conscious FFI marshalling helpers `withGpuLiveParams`
// leans on — moved out of `GpuLiveSession.swift` for the file-size budget
// (#3277). Pure relocation; `bind` is internal rather than `private` only
// because Swift's `private` does not cross file boundaries.

import Foundation
import RawPipeline

extension GpuLiveSession {
  /// Flatten a `ToneCurve` into the FFI's `[x0, y0, x1, y1, …]` f32 layout.
  /// The identity (empty) curve flattens to an empty array, which the FFI
  /// reads as "no curve".
  ///
  /// Built into ONE exactly-sized array rather than via
  /// `flatMap { [Float($0.x), Float($0.y)] }`: the closure form allocates a
  /// throwaway two-element array per control point and then grows the result
  /// as it appends, and this runs four times (luma + R/G/B) on every
  /// `withGpuLiveParams` — i.e. on every live render tick of a curve drag.
  /// CLAUDE.md § Performance invariants does not allow new allocation inside
  /// the render loop. `unsafeUninitializedCapacity` gives one allocation of
  /// the final size and no reallocation.
  ///
  /// Internal rather than `private` so `ToneCurveFlattenTests` can pin the
  /// emitted layout directly — this is the exact interleaving `read_points`
  /// expects on the FFI side, and it is worth a test of its own.
  static func flattened(_ curve: ToneCurve) -> [Float] {
    let points = curve.points
    guard !points.isEmpty else { return [] }
    return [Float](unsafeUninitializedCapacity: points.count * 2) { buffer, initialized in
      for (index, point) in points.enumerated() {
        buffer[index * 2] = Float(point.x)
        buffer[index * 2 + 1] = Float(point.y)
      }
      initialized = points.count * 2
    }
  }

  /// Point a `(ptr, len)` pair at `buffer`, leaving it NULL/0 when empty.
  static func bind(
    _ buffer: UnsafeBufferPointer<Float>,
    to ptr: inout UnsafePointer<Float>?,
    len: inout UInt
  ) {
    guard !buffer.isEmpty, let base = buffer.baseAddress else { return }
    ptr = base
    len = UInt(buffer.count)
  }

  /// Bind the mask stack into `local_adjustments_ptr`/`_len` for the
  /// duration of `body`, encoded with the same 32-float record
  /// `raw_core::types::layers_to_flat` reads (`LocalAdjustmentFlat`).
  ///
  /// Per-call rather than session-owned like `filmLut`/`autoProfile`: the
  /// layer stack is live model state that a slider drag rewrites on the
  /// tick, so there is nothing stable to cache. #3338 — the live path had
  /// never populated these fields, so masks changed nothing on screen.
  func withLocalAdjustmentsBound<R>(
    _ params: MapleGpuLiveParams,
    _ model: AdjustmentModel,
    _ body: (MapleGpuLiveParams) -> R
  ) -> R {
    guard !model.localAdjustments.isEmpty else { return body(params) }
    let flat = LocalAdjustmentFlat.toFlat(model.localAdjustments)
    return flat.withUnsafeBufferPointer { buf in
      var p = params
      p.local_adjustments_ptr = buf.baseAddress
      p.local_adjustments_len = UInt(buf.count)
      return body(p)
    }
  }
}
