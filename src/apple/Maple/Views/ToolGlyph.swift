// ToolGlyph.swift — responsive-program S5c (#625), final artwork (#640).
//
// v0.1 approximated the 22 editor tools with SF Symbols. SF Symbols has no
// Lightroom-style photo-editing glyphs, so the approximations diverged from
// the web set — the same tool showed a different picture on macOS and in the
// browser. This file now draws the shipped artwork directly: the geometry in
// `ToolGlyphShapes` is the same path data the web registry renders, so the two
// platforms are the same drawing by construction.
//
// Spec: docs/design/responsive-program/s5-editor.md §2; s0-icons.md §4.4.
// 16×16 design box, 1.6 stroke, round caps and joins, stroke-only, colour
// inherited from the caller's `foregroundStyle`.

import SwiftUI
import MapleCore

enum ToolGlyph {
    /// The glyph for `tool`, laid out in a `size` × `size` square and stroked
    /// at the artwork's 1.6-per-16 weight. Tint it with `.foregroundStyle`.
    static func icon(for tool: Tool, size: CGFloat) -> ToolGlyphIcon {
        ToolGlyphIcon(tool: tool, size: size)
    }
}

/// Stroke-only rendering of one tool glyph.
struct ToolGlyphIcon: View {
    let tool: Tool
    let size: CGFloat

    /// Stroke weight in the 16×16 design box.
    private static let designStroke: CGFloat = 1.6

    var body: some View {
        ToolGlyphShape(tool: tool)
            .stroke(
                style: StrokeStyle(
                    lineWidth: Self.designStroke * size / 16,
                    lineCap: .round,
                    lineJoin: .round
                )
            )
            .frame(width: size, height: size)
    }
}

/// The glyph geometry, scaled from the 16×16 design box into `rect`.
struct ToolGlyphShape: Shape {
    let tool: Tool

    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let scale = side / 16
        var path = Path()

        for primitive in ToolGlyphShapes.primitives(for: tool) {
            switch primitive {
            case .path(let d):
                path.addPath(SVGPathParser.path(from: d))
            case .circle(let cx, let cy, let r):
                path.addEllipse(
                    in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
            case .roundedRect(let x, let y, let width, let height, let radius):
                path.addRoundedRect(
                    in: CGRect(x: x, y: y, width: width, height: height),
                    cornerSize: CGSize(width: radius, height: radius)
                )
            }
        }

        let offsetX = rect.minX + (rect.width - side) / 2
        let offsetY = rect.minY + (rect.height - side) / 2
        return path.applying(
            CGAffineTransform(scaleX: scale, y: scale)
                .concatenating(CGAffineTransform(translationX: offsetX, y: offsetY))
        )
    }
}

/// Minimal SVG path-data reader — the subset the glyph table uses: `M`/`L`/
/// `H`/`V`/`C`/`Z` in both absolute and relative form. Anything outside that
/// subset is ignored rather than guessed at, so an unsupported command shows
/// up as a missing segment during review instead of as wrong geometry.
enum SVGPathParser {
    static func path(from d: String) -> Path {
        var path = Path()
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero

        for (command, numbers) in lex(d) {
            let relative = command.isLowercase
            let stride = parameterCount(for: command)
            // A command letter may be followed by several parameter sets
            // (`M8 2 4 6` = moveto then lineto); walk them in order.
            var index = 0
            repeat {
                let args = stride > 0 ? Array(numbers[index..<min(index + stride, numbers.count)]) : []
                guard args.count == stride else { break }

                switch Character(command.lowercased()) {
                case "m":
                    let point = resolve(args[0], args[1], from: current, relative: relative)
                    // Repeats of `m` are implicit linetos, per the SVG spec.
                    if index == 0 {
                        path.move(to: point)
                        subpathStart = point
                    } else {
                        path.addLine(to: point)
                    }
                    current = point
                case "l":
                    let point = resolve(args[0], args[1], from: current, relative: relative)
                    path.addLine(to: point)
                    current = point
                case "h":
                    let point = CGPoint(x: relative ? current.x + args[0] : args[0], y: current.y)
                    path.addLine(to: point)
                    current = point
                case "v":
                    let point = CGPoint(x: current.x, y: relative ? current.y + args[0] : args[0])
                    path.addLine(to: point)
                    current = point
                case "c":
                    let c1 = resolve(args[0], args[1], from: current, relative: relative)
                    let c2 = resolve(args[2], args[3], from: current, relative: relative)
                    let end = resolve(args[4], args[5], from: current, relative: relative)
                    path.addCurve(to: end, control1: c1, control2: c2)
                    current = end
                case "z":
                    path.closeSubpath()
                    current = subpathStart
                default:
                    break
                }

                index += max(stride, 1)
            } while index < numbers.count
        }

        return path
    }

    private static func resolve(
        _ x: CGFloat, _ y: CGFloat, from current: CGPoint, relative: Bool
    ) -> CGPoint {
        relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
    }

    private static func parameterCount(for command: Character) -> Int {
        switch Character(command.lowercased()) {
        case "m", "l": return 2
        case "h", "v": return 1
        case "c": return 6
        default: return 0
        }
    }

    /// Split path data into (command, numbers) groups. Numbers may be
    /// separated by spaces, commas, or nothing at all when a sign or a second
    /// decimal point starts the next one (`l0.92-0.92`, `.5.5`).
    private static func lex(_ d: String) -> [(Character, [CGFloat])] {
        var groups: [(Character, [CGFloat])] = []
        var command: Character?
        var numbers: [CGFloat] = []
        var buffer = ""

        func flushNumber() {
            if let value = Double(buffer) { numbers.append(CGFloat(value)) }
            buffer = ""
        }
        func flushGroup() {
            flushNumber()
            if let command { groups.append((command, numbers)) }
            command = nil
            numbers = []
        }

        for character in d {
            if character.isLetter {
                flushGroup()
                command = character
            } else if character == "-" || character == "+" {
                if !buffer.isEmpty && buffer.last != "e" && buffer.last != "E" { flushNumber() }
                buffer.append(character)
            } else if character == "." {
                if buffer.contains(".") { flushNumber() }
                buffer.append(character)
            } else if character.isNumber || character == "e" || character == "E" {
                buffer.append(character)
            } else {
                flushNumber()
            }
        }
        flushGroup()
        return groups
    }
}
