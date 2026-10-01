import Foundation

/// Decode metadata follows pixel density, not crop extent. Compose this only
/// when resampling a buffer; a native-detail crop retains a scale of one.
enum NoiseSamplingScale {
  static func reduced(_ decodedScale: Float, from source: CGSize, to output: CGSize) -> Float {
    let scale = decodedScale.isFinite && decodedScale > 0 ? min(decodedScale, 1) : 1
    let sourceEdge = max(source.width, source.height)
    let outputEdge = max(output.width, output.height)
    guard sourceEdge.isFinite, outputEdge.isFinite, sourceEdge > 0, outputEdge > 0 else {
      return scale
    }
    return scale * Float(min(outputEdge / sourceEdge, 1))
  }
}
