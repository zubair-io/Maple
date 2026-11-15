struct PanoProgressWeights {
  let weights: [(PanoStage, Double)]

  static let preview = PanoProgressWeights(weights: [
    (.decoding, 0.10), (.matching, 0.15), (.graph, 0.55),
    (.solving, 0.00), (.localAlign, 0.10), (.compositing, 0.10),
  ])

  static func stitch(localAlign: PanoOptions.LocalAlign) -> PanoProgressWeights {
    localAlign == .mesh
      ? PanoProgressWeights(weights: [
        (.decoding, 0.20), (.matching, 0.15), (.graph, 0.05), (.solving, 0.15),
        (.localAlign, 0.10), (.compositing, 0.30), (.writing, 0.05),
      ])
      : PanoProgressWeights(weights: [
        (.decoding, 0.20), (.matching, 0.15), (.graph, 0.05), (.solving, 0.20),
        (.localAlign, 0.00), (.compositing, 0.35), (.writing, 0.05),
      ])
  }

  func overall(stage: PanoStage, stageFraction: Double) -> Double {
    guard let index = weights.firstIndex(where: { $0.0 == stage }) else {
      return weights.reduce(0) { $0 + $1.1 }
    }
    let base = weights[..<index].reduce(0) { $0 + $1.1 }
    return base + weights[index].1 * stageFraction
  }
}
