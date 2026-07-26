// ToolGlyphShapes.swift — final tool-glyph artwork (#640).
//
// The Apple half of the editor tool glyph set. Every entry is the *same*
// drawing the web renders from
// `src/web/projects/maple-common/src/lib/icons/tool-glyph-shapes.ts` — the
// path data is copied verbatim so a tool cannot look like one thing on macOS
// and another in the browser. Any edit here must be mirrored there.
//
// Drawing contract: 16×16 box, 1.6 stroke, round caps and joins, stroke-only,
// colour inherited from the call site's `foregroundStyle`.
//
// `captureSharpen` / `captureSigma` are Apple-only tools (deconvolution
// Amount / Sigma); they have no web pill today, so they live only here and are
// drawn in the same family — a focus disc and its radius.

import CoreGraphics
import MapleCore

/// One primitive of a glyph, in the 16×16 design space.
enum ToolGlyphPrimitive {
    case path(String)
    case circle(cx: CGFloat, cy: CGFloat, r: CGFloat)
    case roundedRect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, radius: CGFloat)
}

enum ToolGlyphShapes {
    /// Teardrop outline: apex at (8,2.8) over a circle of r 3.7 at (8,9.6).
    private static let droplet =
        "M8 2.8C6 5.2 4.3 7.4 4.3 9.6C4.3 11.64 5.96 13.3 8 13.3"
        + "C10.04 13.3 11.7 11.64 11.7 9.6C11.7 7.4 10 5.2 8 2.8Z"

    /// Rounded frame shared by the image-wide Effects glyphs.
    private static let frame = ToolGlyphPrimitive.roundedRect(
        x: 2.6, y: 2.6, width: 10.8, height: 10.8, radius: 2.8)

    /// A round-cap dot exactly one stroke-width across.
    private static func dot(_ x: CGFloat, _ y: CGFloat) -> ToolGlyphPrimitive {
        .path("M\(x) \(y)v0.01")
    }

    static func primitives(for tool: Tool) -> [ToolGlyphPrimitive] {
        switch tool {
        // ── Light ───────────────────────────────────────────────────────────
        // Full sun: small core, eight rays. The busiest glyph in the set.
        case .exposure:
            return [
                .circle(cx: 8, cy: 8, r: 2.3),
                .path(
                    "M8 2.2v1.3M8 13.8v-1.3M2.2 8h1.3M13.8 8h-1.3"
                        + "M3.9 3.9l0.92 0.92M12.1 3.9l-0.92 0.92"
                        + "M3.9 12.1l0.92-0.92M12.1 12.1l-0.92-0.92"),
            ]
        // Quieter sibling of Exposure: the same core, four rays not eight.
        case .brightness:
            return [
                .circle(cx: 8, cy: 8, r: 2.2),
                .path("M8 2.2v1.5M8 13.8v-1.5M2.2 8h1.5M13.8 8h-1.5"),
            ]
        // Disc split down the middle — the tonal range pulling apart.
        case .contrast:
            return [.circle(cx: 8, cy: 8, r: 4.8), .path("M8 3.2v9.6")]
        // Sun clearing a horizon — the brightest band of the frame.
        case .highlights:
            return [
                .circle(cx: 8, cy: 6.6, r: 2.4),
                .path("M4.32 2.92l0.71 0.71M11.68 2.92l-0.71 0.71M2.8 6.6h1M13.2 6.6h-1"),
                .path("M2.4 12.4h11.2"),
            ]
        // Crescent — the dark band.
        case .shadows:
            return [
                .path(
                    "M9.95 3.18C7.78 2.3 5.29 2.98 3.87 4.85C2.44 6.71 2.44 9.29 3.87 11.15"
                        + "C5.29 13.02 7.78 13.7 9.95 12.82C8.11 11.92 6.95 10.05 6.95 8"
                        + "C6.95 5.95 8.11 4.08 9.95 3.18Z")
            ]
        // Disc with a chevron riding up — pushing the white point higher.
        case .whites:
            return [.circle(cx: 8, cy: 8, r: 4.8), .path("M5.8 9L8 6.8l2.2 2.2")]
        // Mirror of Whites — pushing the black point down.
        case .blacks:
            return [.circle(cx: 8, cy: 8, r: 4.8), .path("M5.8 7L8 9.2l2.2-2.2")]
        // Tone Curve — the S-curve rising across the plot's diagonal, with
        // the two knots that shape it.
        case .toneCurve:
            return [
                .path("M2.8 13.2C6.2 13.2 5.4 8 8 8s1.8-5.2 5.2-5.2"),
                .circle(cx: 5.6, cy: 10.6, r: 1.1),
                .circle(cx: 10.4, cy: 5.4, r: 1.1),
            ]

        // ── Color ───────────────────────────────────────────────────────────
        // Thermometer, sat left of centre so the ticks balance the mass.
        case .temp:
            return [
                .path("M7.2 3.4v6"),
                .circle(cx: 7.2, cy: 11.3, r: 1.9),
                .path("M9 4.8h1.4M9 7.2h1.4"),
            ]
        // Two overlapping discs — the green/magenta pair mixing.
        case .tint:
            return [.circle(cx: 6.3, cy: 8, r: 3.5), .circle(cx: 9.7, cy: 8, r: 3.5)]
        // Droplet with one low fill chord — colour lifted a little.
        case .vibrance:
            return [.path(droplet), .path("M6.6 10.8h2.8")]
        // Same droplet filled higher — the stronger sibling.
        case .saturation:
            return [.path(droplet), .path("M6.6 10.8h2.8"), .path("M6.7 8.4h2.6")]
        // Three tracks with knobs at different offsets.
        case .hsl:
            return [
                .path("M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"),
                .circle(cx: 5.6, cy: 4.6, r: 1.4),
                .circle(cx: 10, cy: 8, r: 1.4),
                .circle(cx: 7.2, cy: 11.4, r: 1.4),
            ]
        // Disc split down the middle with the left half hatched — the
        // conventional monochrome mark (#276). Shares the disc and divider
        // with Contrast; the three chords are what separate them.
        case .bwMix:
            return [
                .circle(cx: 8, cy: 8, r: 4.8),
                .path("M8 3.2v9.6"),
                .path("M5 5.6h2.3M4.3 8h3M5 10.4h2.3"),
            ]

        // ── Effects ─────────────────────────────────────────────────────────
        // Faceted diamond with a midline — local contrast on the midtones.
        case .clarity:
            return [.path("M8 2.8L13.2 8L8 13.2L2.8 8Z"), .path("M5.8 8h4.4")]
        // Two out-of-phase waves — surface detail, not tone.
        case .texture:
            return [
                .path("M2.6 5.6c1.2-3 2.4 3 3.6 0c1.2-3 2.4 3 3.6 0c1.2-3 2.4 3 3.6 0"),
                .path("M2.6 11c1.2 3 2.4-3 3.6 0c1.2 3 2.4-3 3.6 0c1.2 3 2.4-3 3.6 0"),
            ]
        // Four staggered bands of atmosphere lying across the frame.
        case .dehaze:
            return [.path("M5 3.8h8.4M2.6 6.6h10.8M2.6 9.4h8.8M5 12.2h8.4")]
        // Frame with a bright centre — the corners are what fall away.
        case .vignette:
            return [frame, .circle(cx: 8, cy: 8, r: 3.1)]
        // Frame speckled with dots — film grain across the whole image. The
        // six dots are off-lattice; an even quincunx reads as a die face.
        case .grain:
            return [
                frame, dot(5.4, 5.6), dot(9.8, 4.9), dot(7.2, 7.8), dot(11.1, 8.4),
                dot(5.9, 10.6), dot(9.4, 11.2),
            ]
        // Colour wheel with three zone pucks set around the centre — shadows,
        // midtones and highlights, the three wheels the Color Grading panel
        // stacks over the unweighted global one (#275). Reuses the r-4.8 disc
        // the Light group's tonal glyphs are built on; the pucks are Grain's
        // round-cap dot, so the mark stays inside the family while reading
        // unmistakably as a wheel rather than a tonal band.
        case .colorGrade:
            return [.circle(cx: 8, cy: 8, r: 4.8), dot(8, 5.4), dot(5.8, 9.2), dot(10.2, 9.2)]

        // ── Detail ──────────────────────────────────────────────────────────
        // A single sharp peak rising off a flat baseline — edge acutance.
        case .sharpen:
            return [.path("M2.6 12.2H5L8 4.2l3 8h2.4")]
        // A noisy run settling into a clean line.
        case .noise:
            return [.path("M2.6 8.4L4.2 5.2L5.8 11.2L7.4 6.4L8.8 8.4H13.4")]
        // Noise's sibling — the same settling run, but the disorder is
        // discrete specks sitting on Noise's own vertices: chroma noise.
        case .colorNR:
            return [dot(2.8, 8.4), dot(4.4, 5.8), dot(6, 10.6), .path("M7.8 8.4H13.4")]
        // Capture sharpening Amount — a focus disc with crosshair marks.
        case .captureSharpen:
            return [
                .circle(cx: 8, cy: 8, r: 4.8),
                .path("M5.4 8h1.6M9 8h1.6M8 5.4v1.6M8 9v1.6"),
            ]
        // Capture sharpening Sigma — the same disc, with its radius drawn.
        case .captureSigma:
            return [.circle(cx: 8, cy: 8, r: 4.8), .path("M8 8h3.2")]

        // ── Standalone ──────────────────────────────────────────────────────
        // Two crop rails crossing.
        case .crop:
            return [.path("M4.6 2.6v8.8h8.8"), .path("M2.6 4.6h8.8v8.8")]
        // Two offset cards — a stack of saved looks.
        case .presets:
            return [
                .roundedRect(x: 5.2, y: 2.8, width: 8, height: 8, radius: 2),
                .roundedRect(x: 2.8, y: 5.2, width: 8, height: 8, radius: 2),
            ]
        }
    }
}
