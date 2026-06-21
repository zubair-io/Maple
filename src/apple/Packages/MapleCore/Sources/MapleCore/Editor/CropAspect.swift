// CropAspect.swift — aspect-ratio presets for the crop tool (#638). Swift
// port of the web `crop-aspect.ts`. `ratio` is image-space width:height;
// `.free` means an unconstrained crop, and `.original` resolves to the
// source image's own aspect at apply time.

import Foundation

/// Identifier for a crop aspect-ratio preset. Raw values mirror the web
/// `AspectId` strings so logs / any cross-platform tooling line up.
public enum CropAspectId: String, CaseIterable, Sendable, Hashable {
    case free
    case original
    case square
    case threeTwo   = "3:2"
    case fourThree  = "4:3"
    case sixteenNine = "16:9"
    case twoThree   = "2:3"
    case threeFour  = "3:4"
    case nineSixteen = "9:16"
}

/// A selectable aspect-ratio preset.
public struct CropAspectPreset: Sendable, Hashable, Identifiable {
    public enum Ratio: Sendable, Hashable {
        /// Free (unconstrained) crop.
        case free
        /// Resolve to the source image's aspect at apply time.
        case original
        /// A fixed image-space width / height ratio.
        case fixed(Double)
    }

    public let id: CropAspectId
    public let label: String
    public let ratio: Ratio

    public init(id: CropAspectId, label: String, ratio: Ratio) {
        self.id = id
        self.label = label
        self.ratio = ratio
    }
}

public enum CropAspect {
    /// The ordered preset list shown in the crop toolbar — same order and
    /// labels as the web `ASPECT_PRESETS`.
    public static let presets: [CropAspectPreset] = [
        CropAspectPreset(id: .free,        label: "Free",     ratio: .free),
        CropAspectPreset(id: .original,    label: "Original", ratio: .original),
        CropAspectPreset(id: .square,      label: "1:1",      ratio: .fixed(1)),
        CropAspectPreset(id: .threeTwo,    label: "3:2",      ratio: .fixed(3.0 / 2.0)),
        CropAspectPreset(id: .fourThree,   label: "4:3",      ratio: .fixed(4.0 / 3.0)),
        CropAspectPreset(id: .sixteenNine, label: "16:9",     ratio: .fixed(16.0 / 9.0)),
        CropAspectPreset(id: .twoThree,    label: "2:3",      ratio: .fixed(2.0 / 3.0)),
        CropAspectPreset(id: .threeFour,   label: "3:4",      ratio: .fixed(3.0 / 4.0)),
        CropAspectPreset(id: .nineSixteen, label: "9:16",     ratio: .fixed(9.0 / 16.0)),
    ]

    /// Look up a preset by id, falling back to `.free` for an unknown id.
    public static func preset(for id: CropAspectId) -> CropAspectPreset {
        presets.first { $0.id == id } ?? presets[0]
    }

    /// Resolve a preset to a concrete image-space aspect (width / height),
    /// or `nil` for a free crop. `imgW`/`imgH` resolve the `.original`
    /// preset.
    public static func resolveAspect(
        _ preset: CropAspectPreset, imgW: Double, imgH: Double
    ) -> Double? {
        switch preset.ratio {
        case .free:
            return nil
        case .original:
            return imgH > 0 ? imgW / imgH : nil
        case .fixed(let r):
            return r
        }
    }
}
