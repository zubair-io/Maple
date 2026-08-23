// MuiWhiteboardCanvas.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). A freeform drawing surface with a
// pen/eraser toolbar and an AI-prompt bar underneath, built from Canvas
// Surface, Toolbar, Command Menu (approximated here as Input + Button —
// see file note below).
//
// Only `pen` strokes are ever stored — the eraser removes strokes from the
// array rather than adding one of its own, matching the web reference. All
// drawing math (stroke capture, eraser hit-test) lives in
// `MuiWhiteboardCanvasMath`; this view owns only gesture wiring and
// rendering.

import SwiftUI

public enum MuiWhiteboardTool: Sendable {
    case pen, eraser
}

public struct MuiWhiteboardCanvas: View {
    @Binding public var tool: MuiWhiteboardTool
    @Binding public var strokes: [MuiWhiteboardStroke]
    @Binding public var prompt: String
    public let promptSubmitted: ((String) -> Void)?

    @State private var inProgressPoints: [CGPoint] = []

    private static let toolbarEntries: [MuiToolbarEntry] = [
        .item(MuiToolbarActionItem(id: "pen", icon: "pencil", label: "Pen")),
        .item(MuiToolbarActionItem(id: "eraser", icon: "eraser", label: "Eraser")),
        .divider,
        .item(MuiToolbarActionItem(id: "clear", icon: "trash", label: "Clear")),
    ]

    public init(
        tool: Binding<MuiWhiteboardTool>,
        strokes: Binding<[MuiWhiteboardStroke]>,
        prompt: Binding<String>,
        promptSubmitted: ((String) -> Void)? = nil
    ) {
        self._tool = tool
        self._strokes = strokes
        self._prompt = prompt
        self.promptSubmitted = promptSubmitted
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiToolbar(entries: Self.toolbarEntries, itemSelected: handleToolbarAction)

            MuiCanvasSurface { _ in
                Canvas { context, _ in
                    for stroke in strokes {
                        drawStroke(stroke.points, in: &context)
                    }
                    drawStroke(inProgressPoints, in: &context)
                }
                .contentShape(Rectangle())
                .gesture(drawGesture)
            }
            .frame(minHeight: 180)

            HStack(spacing: MuiTokens.spacingSm) {
                MuiInput(value: $prompt, accessibilityLabel: "AI prompt", placeholder: "Describe what to draw…", onCommit: submitPrompt)
                MuiButton(label: "Generate", variant: .primary, size: .sm) { submitPrompt() }
            }
        }
    }

    private func drawStroke(_ points: [CGPoint], in context: inout GraphicsContext) {
        guard points.count > 1 else { return }
        var path = Path()
        path.addLines(points)
        context.stroke(path, with: .color(MuiTokens.primary), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
    }

    private var drawGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                switch tool {
                case .pen:
                    inProgressPoints.append(value.location)
                case .eraser:
                    strokes = MuiWhiteboardCanvasMath.erasing(strokes, at: value.location)
                }
            }
            .onEnded { _ in
                guard tool == .pen, inProgressPoints.count > 1 else {
                    inProgressPoints = []
                    return
                }
                strokes.append(MuiWhiteboardStroke(points: inProgressPoints))
                inProgressPoints = []
            }
    }

    private func handleToolbarAction(_ id: String) {
        switch id {
        case "pen": tool = .pen
        case "eraser": tool = .eraser
        case "clear": strokes = []
        default: break
        }
    }

    private func submitPrompt() {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        promptSubmitted?(trimmed)
        prompt = ""
    }
}

#Preview("MuiWhiteboardCanvas") {
    struct Demo: View {
        @State private var tool: MuiWhiteboardTool = .pen
        @State private var strokes: [MuiWhiteboardStroke] = []
        @State private var prompt = ""
        var body: some View {
            MuiWhiteboardCanvas(tool: $tool, strokes: $strokes, prompt: $prompt)
                .frame(width: 320, height: 280)
                .padding()
                .background(MuiTokens.bg)
        }
    }
    return Demo()
}
