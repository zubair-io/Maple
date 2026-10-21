// ColorCurvePicker.swift — Oklab secondary color curve descriptors, curve
// math helpers, and the stage-input eyedropper controller (#5077).

import Foundation

public enum ColorCurveKind: String, CaseIterable, Sendable, Identifiable {
  case hueVsHue
  case hueVsSat
  case hueVsLuma
  case lumaVsSat
  case satVsSat
  case satVsLuma

  public var id: String { rawValue }

  public var shortLabel: String {
    switch self {
    case .hueVsHue: return "H vs H"
    case .hueVsSat: return "H vs S"
    case .hueVsLuma: return "H vs L"
    case .lumaVsSat: return "L vs S"
    case .satVsSat: return "S vs S"
    case .satVsLuma: return "S vs L"
    }
  }

  public var title: String {
    switch self {
    case .hueVsHue: return "Hue vs Hue"
    case .hueVsSat: return "Hue vs Sat"
    case .hueVsLuma: return "Hue vs Luma"
    case .lumaVsSat: return "Luma vs Sat"
    case .satVsSat: return "Sat vs Sat"
    case .satVsLuma: return "Sat vs Luma"
    }
  }

  public var isPeriodic: Bool {
    switch self {
    case .hueVsHue, .hueVsSat, .hueVsLuma: return true
    case .lumaVsSat, .satVsSat, .satVsLuma: return false
    }
  }

  public var keyPath: WritableKeyPath<AdjustmentModel, ToneCurve> {
    switch self {
    case .hueVsHue: return \.colorCurveHueVsHue
    case .hueVsSat: return \.colorCurveHueVsSat
    case .hueVsLuma: return \.colorCurveHueVsLuma
    case .lumaVsSat: return \.colorCurveLumaVsSat
    case .satVsSat: return \.colorCurveSatVsSat
    case .satVsLuma: return \.colorCurveSatVsLuma
    }
  }

  public func sampleX(from sample: ColorCurveSample) -> Double {
    switch self {
    case .hueVsHue, .hueVsSat, .hueVsLuma: return sample.uH
    case .lumaVsSat: return sample.uL
    case .satVsSat, .satVsLuma: return sample.uC
    }
  }

  public static let quickHueAnchors: [(id: String, label: String, deg: Double, swatch: UInt32)] = [
    ("red", "Red", 29.0, 0xC4493A),
    ("yellow", "Yellow", 110.0, 0xE3D24A),
    ("green", "Green", 142.0, 0x3FAE6A),
    ("cyan", "Cyan", 195.0, 0x45B6C4),
    ("blue", "Blue", 264.0, 0x3B6FB0),
    ("magenta", "Magenta", 328.0, 0xC64FB0),
  ]

  public static let skinToneGuardDeg: [Double] = [38.0, 55.0, 72.0]

  public func insertingAnchor(x: Double, y: Double = 0.5, into curve: ToneCurve) -> ToneCurve {
    let clampedX = min(max(x, 0.0), 1.0)
    let clampedY = min(max(y, 0.0), 1.0)
    var pts = curve.points
    if let idx = pts.firstIndex(where: { abs($0.x - clampedX) < 0.015 }) {
      pts[idx] = (x: clampedX, y: clampedY)
    } else {
      pts.append((x: clampedX, y: clampedY))
    }
    pts.sort { $0.x < $1.x }
    return ToneCurve(points: pts)
  }

  public func lockingSkinTone(into curve: ToneCurve) -> ToneCurve {
    guard isPeriodic else { return curve }
    var pts = curve.points
    for deg in Self.skinToneGuardDeg {
      let x = deg / 360.0
      if !pts.contains(where: { abs($0.x - x) < 0.015 }) {
        pts.append((x: x, y: 0.5))
      }
    }
    pts.sort { $0.x < $1.x }
    return ToneCurve(points: pts)
  }

  /// Clamps `proposedY` to `[0, 1]`, and for `Hue vs Hue` enforces the
  /// non-folding slope limit $|\Delta y| \le 2.5 \cdot \Delta x$ against
  /// immediate neighbors so the output hue mapping stays monotonic.
  public func clampY(
    forX x: Double, proposedY: Double, in points: [ToneCurvePoint], excludingIndex: Int? = nil
  ) -> Double {
    var lo = 0.0
    var hi = 1.0
    guard self == .hueVsHue else { return min(max(proposedY, lo), hi) }
    let others = points.enumerated().compactMap { i, p in i == excludingIndex ? nil : p }
      .sorted { $0.x < $1.x }
    guard !others.isEmpty else { return min(max(proposedY, lo), hi) }

    let prev = others.last(where: { $0.x < x }) ?? others.last!
    let next = others.first(where: { $0.x > x }) ?? others.first!
    let dxPrev = prev.x < x ? (x - prev.x) : (x + 1.0 - prev.x)
    let dxNext = next.x > x ? (next.x - x) : (next.x + 1.0 - x)
    let maxDeltaPrev = 2.5 * max(dxPrev, 0.01)
    let maxDeltaNext = 2.5 * max(dxNext, 0.01)
    lo = max(lo, prev.y - maxDeltaPrev, next.y - maxDeltaNext)
    hi = min(hi, prev.y + maxDeltaPrev, next.y + maxDeltaNext)
    if lo > hi { return 0.5 * (lo + hi) }
    return min(max(proposedY, lo), hi)
  }

  /// Evaluate the curve at `x` in `[0, 1]` using the same Fritsch-Carlson
  /// monotone Hermite spline (`stages::color_curves`) so the UI path matches
  /// the 256-sample LUT.
  public func evaluate(at x: Double, points: [ToneCurvePoint]) -> Double {
    let sorted = points.sorted { $0.x < $1.x }
    guard !sorted.isEmpty else { return 0.5 }
    if sorted.count == 1 { return min(max(sorted[0].y, 0.0), 1.0) }
    let u = isPeriodic ? (x - floor(x)) : min(max(x, 0.0), 1.0)
    var xs: [Double] = []
    var ys: [Double] = []
    if isPeriodic {
      for p in sorted {
        xs.append(p.x - 1.0)
        ys.append(p.y)
      }
      for p in sorted {
        xs.append(p.x)
        ys.append(p.y)
      }
      for p in sorted {
        xs.append(p.x + 1.0)
        ys.append(p.y)
      }
    } else {
      xs = sorted.map { $0.x }
      ys = sorted.map { $0.y }
      if u <= xs[0] { return ys[0] }
      if u >= xs[xs.count - 1] { return ys[ys.count - 1] }
    }
    return Self.evalHermite(x: u, xs: xs, ys: ys)
  }

  private static func evalHermite(x: Double, xs: [Double], ys: [Double]) -> Double {
    let n = xs.count
    var deltas = [Double](repeating: 0, count: n - 1)
    for k in 0..<(n - 1) {
      let h = xs[k + 1] - xs[k]
      deltas[k] = h > 1e-6 ? (ys[k + 1] - ys[k]) / h : 0
    }
    var m = [Double](repeating: 0, count: n)
    m[0] = deltas[0]
    m[n - 1] = deltas[n - 2]
    for k in 1..<(n - 1) {
      if deltas[k - 1] * deltas[k] <= 0 {
        m[k] = 0
      } else {
        m[k] = 0.5 * (deltas[k - 1] + deltas[k])
      }
    }
    var seg = 0
    for k in 0..<(n - 1) where x >= xs[k] && x <= xs[k + 1] {
      seg = k
      break
    }
    let h = xs[seg + 1] - xs[seg]
    guard h > 1e-6 else { return min(max(ys[seg], 0.0), 1.0) }
    let t = (x - xs[seg]) / h
    let t2 = t * t
    let t3 = t2 * t
    let h00 = 2 * t3 - 3 * t2 + 1
    let h10 = t3 - 2 * t2 + t
    let h01 = -2 * t3 + 3 * t2
    let h11 = t3 - t2
    let y = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1]
    return min(max(y, 0.0), 1.0)
  }
}

@MainActor
@Observable
public final class ColorCurvePicker {
  public var isColorCurvesMode = false
  public var activeKind: ColorCurveKind = .hueVsHue
  public private(set) var isArmed = false
  public private(set) var isSampling = false
  public private(set) var message: String?
  private let session: EditSession
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored var provider:
    @Sendable (AssetRef, AdjustmentModel, CGPoint) async throws -> ColorCurveSample = {
      try await ColorCurveSampler.sample(asset: $0, model: $1, point: $2)
    }

  public init(session: EditSession) { self.session = session }

  public func arm() {
    cancel()
    guard session.asset.isRaw else {
      message = ColorCurveSampleError.unsupportedAsset.localizedDescription
      return
    }
    isArmed = true
  }

  public func cancel() {
    generation &+= 1
    isArmed = false
    isSampling = false
    message = nil
  }

  public func pick(at point: CGPoint?) async {
    guard isArmed, !isSampling else { return }
    guard let point else {
      message = ColorCurveSampleError.outsideImage.localizedDescription
      return
    }
    let request = generation
    let before = session.model
    let transactionID = session.transactions.nextID
    let kind = activeKind
    isSampling = true
    message = nil
    defer { if request == generation { isSampling = false } }
    do {
      let sample = try await provider(session.asset, before, point)
      guard request == generation, !Task.isCancelled else { return }
      guard session.model == before, session.transactions.nextID == transactionID else {
        message = "The photo changed while sampling. Pick the colour again."
        return
      }
      let x = kind.sampleX(from: sample)
      guard x.isFinite else { throw ColorCurveSampleError.failed }
      var sampled = before
      sampled[keyPath: kind.keyPath] = kind.insertingAnchor(
        x: x, y: 0.5, into: sampled[keyPath: kind.keyPath])
      session.beginEdit(description: "Sample \(kind.title) anchor")
      session.model = sampled
      session.endEdit()
      isArmed = false
    } catch {
      guard request == generation, !Task.isCancelled else { return }
      message = (error as? ColorCurveSampleError ?? .failed).localizedDescription
    }
  }
}
