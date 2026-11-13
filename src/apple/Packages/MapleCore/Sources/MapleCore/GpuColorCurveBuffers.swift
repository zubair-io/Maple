/// Actor-owned FFI storage; unchanged secondary curves reuse their allocation.
struct GpuCurveBuffer {
  private var curve: ToneCurve?
  private var flat: [Float] = []

  mutating func resolve(_ value: ToneCurve) -> [Float] {
    if curve != value {
      curve = value
      flat = GpuLiveSession.flattened(value)
    }
    return flat
  }
}

struct GpuColorCurveBuffers {
  var hvh = GpuCurveBuffer()
  var hvs = GpuCurveBuffer()
  var hvl = GpuCurveBuffer()
  var lvs = GpuCurveBuffer()
  var svs = GpuCurveBuffer()
  var svl = GpuCurveBuffer()
}
