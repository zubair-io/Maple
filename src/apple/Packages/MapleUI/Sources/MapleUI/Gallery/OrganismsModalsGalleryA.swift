// OrganismsModalsGalleryA.swift — Organisms §4.4 (Modals), first seven:
// Export, Batch Rename, Batch Metadata, Move To, Panorama Merge, Selective
// Paste, Library Picker. See OrganismsGallerySection.swift for the tab this
// feeds into, and OrganismsModalsGalleryB.swift for the remaining six.
//
// Every modal demo defaults `open = false` and renders `contained: true` —
// a modal that defaulted open in the showcase stacked into an unreadable
// pile on the web lane; each card instead shows a trigger button and boxes
// the opened shell to the card's own frame instead of the whole screen.

import SwiftUI

struct OrganismsModalsGalleryA: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            GallerySpecimenCard(name: "Export", purpose: "Format, size, quality, color space", builtFrom: "Form Field, Progress, Banner") { ExportModalDemo() }
            GallerySpecimenCard(name: "Batch Rename", purpose: "Template with live preview", builtFrom: "Form Field, Chip Row, Preview List, Progress") { BatchRenameModalDemo() }
            GallerySpecimenCard(name: "Batch Metadata", purpose: "Multi-field editor with confirm", builtFrom: "Form Field, Dialog, Progress") { BatchMetadataModalDemo() }
            GallerySpecimenCard(name: "Move To", purpose: "Tree destination picker", builtFrom: "Tree Row, Search Bar, Button") { MoveToModalDemo() }
            GallerySpecimenCard(name: "Panorama Merge", purpose: "Stitch options and progress", builtFrom: "Form Field, Progress, Media Cell") { PanoramaMergeModalDemo() }
            GallerySpecimenCard(name: "Selective Paste", purpose: "Per-group apply toggles", builtFrom: "Checkbox, Text, Button") { SelectivePasteModalDemo() }
            GallerySpecimenCard(name: "Library Picker", purpose: "Remote filesystem browser", builtFrom: "Tree Row, Toolbar, Empty State") { LibraryPickerModalDemo() }
        }
    }
}

private struct ExportModalDemo: View {
    @State private var open = false
    @State private var format = "jpeg"
    @State private var quality = 90
    @State private var colorSpace = "srgb"
    var body: some View {
        ZStack {
            MuiButton(label: "Open Export", variant: .secondary) { open = true }
            MuiExportModal(
                isPresented: open, contained: true,
                formatOptions: [MuiSegmentedOption(value: "jpeg", label: "JPEG"), MuiSegmentedOption(value: "tiff", label: "TIFF")],
                colorSpaceOptions: [MuiSegmentedOption(value: "srgb", label: "sRGB"), MuiSegmentedOption(value: "p3", label: "P3")],
                format: $format, quality: $quality, colorSpace: $colorSpace,
                dismissed: { open = false }
            )
        }
        .frame(height: 240)
    }
}

private struct BatchRenameModalDemo: View {
    @State private var open = false
    @State private var template = "{date}_{seq}"
    var body: some View {
        ZStack {
            MuiButton(label: "Open Batch Rename", variant: .secondary) { open = true }
            MuiBatchRenameModal(
                isPresented: open, contained: true,
                items: [
                    MuiBatchRenameSourceItem(id: "1", filename: "IMG_0042.dng", date: "2026-08-01", camera: "SonyA7IV"),
                    MuiBatchRenameSourceItem(id: "2", filename: "IMG_0043.dng", date: "2026-08-01", camera: "SonyA7IV"),
                ],
                template: $template, dismissed: { open = false }
            )
        }
        .frame(height: 280)
    }
}

private struct BatchMetadataModalDemo: View {
    @State private var open = false
    @State private var copyright = "© Just Maple"
    @State private var keywords = ["Iceland", "Glacier"]
    @State private var rating = 4
    var body: some View {
        ZStack {
            MuiButton(label: "Open Batch Metadata", variant: .secondary) { open = true }
            MuiBatchMetadataModal(
                isPresented: open, contained: true, itemCount: 12,
                copyright: $copyright, keywords: $keywords, rating: $rating,
                dismissed: { open = false }
            )
        }
        .frame(height: 300)
    }
}

private struct MoveToModalDemo: View {
    @State private var open = false
    @State private var selected: String?
    var body: some View {
        ZStack {
            MuiButton(label: "Open Move To", variant: .secondary) { open = true }
            MuiMoveToModal(
                isPresented: open, contained: true,
                nodes: [
                    MuiMoveToTreeNode(id: "trips", parentId: nil, name: "Trips", depth: 0, hasChildren: true),
                    MuiMoveToTreeNode(id: "iceland", parentId: "trips", name: "Iceland 2026", depth: 1, hasChildren: false),
                ],
                selectedId: $selected, dismissed: { open = false }
            )
        }
        .frame(height: 280)
    }
}

private struct PanoramaMergeModalDemo: View {
    @State private var open = false
    @State private var projection = "spherical"
    @State private var blendMode = "linear"
    var body: some View {
        ZStack {
            MuiButton(label: "Open Panorama Merge", variant: .secondary) { open = true }
            MuiPanoramaMergeModal(
                isPresented: open, contained: true,
                frames: (1...4).map { MuiPanoramaFrame(id: "\($0)", url: nil, alt: "Frame \($0)") },
                projection: $projection, blendMode: $blendMode, dismissed: { open = false }
            )
        }
        .frame(height: 280)
    }
}

private struct SelectivePasteModalDemo: View {
    @State private var open = false
    @State private var groups = [
        MuiSelectivePasteGroup(id: "light", label: "Light", description: "Exposure, contrast, highlights", enabled: true),
        MuiSelectivePasteGroup(id: "color", label: "Color", description: "White balance, HSL", enabled: false),
    ]
    var body: some View {
        ZStack {
            MuiButton(label: "Open Selective Paste", variant: .secondary) { open = true }
            MuiSelectivePasteModal(isPresented: open, contained: true, groups: $groups, dismissed: { open = false })
        }
        .frame(height: 260)
    }
}

private struct LibraryPickerModalDemo: View {
    @State private var open = false
    @State private var selected: String?
    var body: some View {
        ZStack {
            MuiButton(label: "Open Library Picker", variant: .secondary) { open = true }
            MuiLibraryPickerModal(
                isPresented: open, contained: true,
                pathSegments: ["Volumes", "Photos"],
                entries: [
                    MuiLibraryPickerEntry(id: "1", name: "2026", kind: .folder, itemCount: 4200),
                    MuiLibraryPickerEntry(id: "2", name: "manifest.json", kind: .file),
                ],
                selectedId: $selected, dismissed: { open = false }
            )
        }
        .frame(height: 300)
    }
}
