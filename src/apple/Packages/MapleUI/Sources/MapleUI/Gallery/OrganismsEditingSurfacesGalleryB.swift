// OrganismsEditingSurfacesGalleryB.swift — Organisms §4.5 (Editing
// surfaces), remaining four: Rich Text Editor, Whiteboard Canvas,
// Structured Data Editor, Preview Surface. See OrganismsGallerySection.swift
// for the tab this feeds into, and OrganismsEditingSurfacesGalleryA.swift
// for the first five.

import SwiftUI

struct OrganismsEditingSurfacesGalleryB: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            GallerySpecimenCard(name: "Rich Text Editor", purpose: "Structured document editing", builtFrom: "Bubble Menu, Command Menu, Suggestion Menu, Embed Shell, Code Block") { RichTextEditorDemo() }
            GallerySpecimenCard(name: "Whiteboard Canvas", purpose: "Freeform canvas with AI prompt", builtFrom: "Canvas Surface, Toolbar, Command Menu") { WhiteboardCanvasDemo() }
            GallerySpecimenCard(name: "Structured Data Editor", purpose: "JSON as code or as a form", builtFrom: "Code Block, Form Field, Tabs") { StructuredDataEditorDemo() }
            GallerySpecimenCard(name: "Preview Surface", purpose: "Full-screen media preview", builtFrom: "Page Header, Filmstrip, Preview Image, Video Player, Toolbar") { PreviewSurfaceDemo() }
        }
    }
}

private struct RichTextEditorDemo: View {
    @State private var value = "A lone hiker crosses a black-sand beach at dusk."
    var body: some View {
        MuiRichTextEditor(value: $value)
            .frame(width: 280)
    }
}

private struct WhiteboardCanvasDemo: View {
    @State private var tool: MuiWhiteboardTool = .pen
    @State private var strokes: [MuiWhiteboardStroke] = []
    @State private var prompt = ""
    var body: some View {
        MuiWhiteboardCanvas(tool: $tool, strokes: $strokes, prompt: $prompt)
            .frame(width: 280, height: 240)
    }
}

private struct StructuredDataEditorDemo: View {
    @State private var fields: [MuiStructuredDataField] = [
        MuiStructuredDataField(key: "camera", value: .string("Sony A7 IV")),
        MuiStructuredDataField(key: "iso", value: .number(400)),
        MuiStructuredDataField(key: "flagged", value: .bool(false)),
    ]
    var body: some View {
        MuiStructuredDataEditor(fields: $fields)
            .frame(width: 280)
    }
}

private struct PreviewSurfaceDemo: View {
    @State private var active: String? = "1"
    var body: some View {
        MuiPreviewSurface(
            items: [
                MuiPreviewSurfaceItem(id: "1", kind: .image, url: nil, alt: "Iceland glacier"),
                MuiPreviewSurfaceItem(id: "2", kind: .video, url: nil, alt: "Trip clip"),
            ],
            activeId: $active, title: "IMG_0042.dng"
        )
        .frame(width: 300, height: 260)
    }
}
