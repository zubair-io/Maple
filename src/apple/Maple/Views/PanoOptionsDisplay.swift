// PanoOptionsDisplay.swift — Picker names and help text for the panorama
// options shown in PanoMergeView.

import MapleCore

// MARK: - Option display name + help text extensions

extension PanoOptions.Retention {
  var displayName: String {
    switch self {
    case .keep: return "Keep (recommended)"
    case .strict: return "Strict"
    }
  }
  var helpText: String {
    switch self {
    case .keep:
      return "Include frames even when overlap quality is marginal. Best for wide sequences."
    case .strict:
      return "Exclude frames below the overlap quality threshold. Cleaner seams on dense sequences."
    }
  }
}

extension PanoOptions.LocalAlign {
  var displayName: String {
    switch self {
    case .mesh: return "Mesh warp (recommended)"
    case .off: return "Off"
    }
  }
  var helpText: String {
    switch self {
    case .mesh: return "Corrects residual lens-roll and perspective drift after global solving."
    case .off: return "Skip the mesh pass. Faster; suitable when lens distortion is negligible."
    }
  }
}

extension PanoOptions.Strategy {
  var displayName: String {
    switch self {
    case .auto: return "Auto (recommended)"
    case .rotation: return "Rotation"
    case .tile: return "Flat tile"
    }
  }
  var helpText: String {
    switch self {
    case .auto: return "Solver picks the best geometry model based on the feature graph topology."
    case .rotation: return "Pure rotation from a fixed pivot. Best for handheld panoramic pans."
    case .tile: return "Flat-plane tiling. Best for copy-stand or flat-art sequences."
    }
  }
}
