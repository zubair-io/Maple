// MoleculesL1MediaGallery.swift — Molecules L1 tab, catalog §2.7 Media:
// Map Annotation, Preview Image, Video Player, Audio Player, Drag Preview,
// Code Block. The players are given no `url` (no real network/asset in
// the gallery) — their transport bar still runs against the players' own
// preset placeholder demo state.

import SwiftUI

extension MoleculesL1GallerySection2 {
    var mapAnnotationCard: some View {
        GallerySpecimenCard(name: "Map Annotation", purpose: "Thumbnail pin or count cluster", builtFrom: "Image, Badge, Text") {
            HStack(alignment: .top, spacing: 20) {
                MuiMapAnnotation(label: "Golden Gate")
                MuiMapAnnotation(label: "Cluster", count: 12)
            }
        }
    }

    var previewImageCard: some View {
        GallerySpecimenCard(name: "Preview Image", purpose: "Static image with load lifecycle", builtFrom: "Image, Spinner") {
            MuiPreviewImage(url: nil, alt: "Preview")
                .frame(width: 88, height: 64)
        }
    }

    var videoPlayerCard: some View {
        GallerySpecimenCard(name: "Video Player", purpose: "Playback with transport controls", builtFrom: "Button, Progress, Timestamp") {
            MuiVideoPlayer(url: nil)
                .frame(width: 200)
        }
    }

    var audioPlayerCard: some View {
        GallerySpecimenCard(name: "Audio Player", purpose: "Waveform-less audio transport", builtFrom: "Button, Progress, Timestamp") {
            MuiAudioPlayer(url: nil, title: "Voice memo")
                .frame(width: 200)
        }
    }

    var dragPreviewCard: some View {
        GallerySpecimenCard(name: "Drag Preview", purpose: "Ghost shown while dragging", builtFrom: "Image, Badge") {
            HStack(spacing: 20) {
                MuiDragPreview(url: nil)
                MuiDragPreview(url: nil, count: 5)
            }
        }
    }

    var codeBlockCard: some View {
        GallerySpecimenCard(name: "Code Block", purpose: "Monospace block with copy", builtFrom: "Text, Button") {
            MuiCodeBlock(code: "let exposure = 0.3", language: "swift")
                .frame(width: 200)
        }
    }
}
