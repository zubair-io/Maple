// ToolGlyph.swift — responsive-program S5c (#625).
//
// Apple side of the 22 tool glyphs. v0.1 uses SF Symbols approximations
// per the prompt — designer-quality custom artwork is a follow-up. Each
// case picks a recognizable Symbol close to the tool's intent; where SF
// Symbols genuinely has no match (`splitTone`, `colorNR`) we lean on
// shape-suggestive symbols (`drop.halffull`, `wand.and.rays`).
//
// Spec: docs/design/responsive-program/s5-editor.md §2; spec docs
// /design/responsive-program/s0-icons.md §4.4 (deferred to S5).

import SwiftUI
import MapleCore

enum ToolGlyph {
    /// SF Symbol name for the given tool.
    static func sfSymbol(for tool: Tool) -> String {
        switch tool {
        // Light
        case .exposure:   return "sun.max"
        case .contrast:   return "circle.righthalf.filled"
        case .highlights: return "sun.max.fill"
        case .shadows:    return "moon.fill"
        case .whites:     return "circle.fill"
        case .blacks:     return "circle"

        // Color
        case .temp:       return "thermometer.medium"
        case .tint:       return "paintpalette"
        case .vibrance:   return "drop.halffull"
        case .saturation: return "drop.fill"
        case .hsl:        return "rectangle.stack.fill"

        // Effects
        case .clarity:    return "diamond"
        case .texture:    return "scribble.variable"
        case .dehaze:     return "wind"
        case .vignette:   return "circle.dashed"
        case .grain:      return "circle.grid.3x3.fill"
        case .splitTone:  return "rectangle.lefthalf.inset.filled"

        // Detail
        case .sharpen:        return "triangle"
        case .noise:          return "waveform"
        case .colorNR:        return "wand.and.rays"
        // Capture-sharpening (deconvolution) Amount / Sigma — focus-/
        // lens-flavoured glyphs to read distinct from plain Sharpen.
        case .captureSharpen: return "camera.aperture"
        case .captureSigma:   return "circle.dotted"
        case .crop:           return "crop"
        case .presets:        return "square.stack.3d.up"
        }
    }
}
