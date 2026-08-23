// OrganismsPanelsGalleryB.swift — Organisms §4.3 (Inspectors & panels),
// second half: Film Panel, Presets Panel, Scopes Panel, Backlinks Panel,
// Version History Panel, Thread Panel. See OrganismsGallerySection.swift
// for the tab this feeds into, and OrganismsPanelsGalleryA.swift for the
// first seven.

import SwiftUI

struct OrganismsPanelsGalleryB: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            filmPanelCard
            presetsPanelCard
            scopesPanelCard
            backlinksPanelCard
            versionHistoryPanelCard
            threadPanelCard
        }
    }

    private var filmPanelCard: some View {
        GallerySpecimenCard(name: "Film Panel", purpose: "Look catalog with strength", builtFrom: "Chip Row, Card, Living Slider") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                FilmPanelDemo()
                VStack(alignment: .leading, spacing: 2) {
                    MuiText("Empty", variant: .toolLabel, color: .muted)
                    MuiFilmPanel(looks: [])
                        .frame(width: 160, height: 220)
                        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
                }
            }
        }
    }

    private var presetsPanelCard: some View {
        GallerySpecimenCard(name: "Presets Panel", purpose: "Save, apply, delete presets", builtFrom: "List Row, Button, Dialog") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                PresetsPanelDemo()
                statesColumn(
                    loading: { MuiPresetsPanel(presets: [], loading: true) },
                    empty: { MuiPresetsPanel(presets: []) }
                )
            }
        }
    }

    private var scopesPanelCard: some View {
        GallerySpecimenCard(name: "Scopes Panel", purpose: "Pinned four-up scope stack", builtFrom: "Histogram, Waveform, Parade, Vectorscope") {
            ScopesPanelDemo()
        }
    }

    private var backlinksPanelCard: some View {
        GallerySpecimenCard(name: "Backlinks Panel", purpose: "Inbound references", builtFrom: "List Row, Empty State") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                BacklinksPanelDemo()
                statesColumn(
                    loading: { MuiBacklinksPanel(links: [], loading: true) },
                    empty: { MuiBacklinksPanel(links: []) }
                )
            }
        }
    }

    private var versionHistoryPanelCard: some View {
        GallerySpecimenCard(name: "Version History Panel", purpose: "Browse and restore versions", builtFrom: "List Row, Timestamp, Button, Dialog") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                VersionHistoryPanelDemo()
                statesColumn(
                    loading: { MuiVersionHistoryPanel(versions: [], loading: true) },
                    empty: { MuiVersionHistoryPanel(versions: []) }
                )
            }
        }
    }

    private var threadPanelCard: some View {
        GallerySpecimenCard(name: "Thread Panel", purpose: "Reply thread", builtFrom: "Chat Message, Input, Button") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                ThreadPanelDemo()
                statesColumn(
                    loading: { MuiThreadPanel(messages: [], loading: true) },
                    empty: { MuiThreadPanel(messages: []) }
                )
            }
        }
    }

    private func statesColumn(loading: @escaping () -> some View, empty: @escaping () -> some View) -> some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            labeled("Loading", loading())
            labeled("Empty", empty())
        }
    }

    private func labeled(_ label: String, _ content: some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MuiText(label, variant: .toolLabel, color: .muted)
            content
                .frame(width: 160, height: 76)
                .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        }
    }
}

private struct FilmPanelDemo: View {
    @State private var strength = 80.0
    @State private var category: String?
    @State private var selected: String? = "kodak"
    var body: some View {
        MuiFilmPanel(
            categories: [MuiChip(id: "film", label: "Film"), MuiChip(id: "digital", label: "Digital")],
            looks: [
                MuiFilmLook(id: "kodak", name: "Kodak Gold", url: nil, category: "film"),
                MuiFilmLook(id: "portra", name: "Portra 400", url: nil, category: "film"),
            ],
            strength: $strength,
            activeCategoryId: $category,
            selectedLookId: $selected
        )
        .frame(width: 240, height: 300)
    }
}

private struct PresetsPanelDemo: View {
    var body: some View {
        MuiPresetsPanel(presets: [
            MuiPresetItem(id: "1", name: "Moody Landscape", updatedAt: Date().addingTimeInterval(-3600)),
            MuiPresetItem(id: "2", name: "Portrait Warm", updatedAt: Date().addingTimeInterval(-86400)),
        ])
        .frame(width: 220, height: 180)
    }
}

private struct ScopesPanelDemo: View {
    var body: some View {
        MuiScopesPanel(sample: MuiScopeSample(
            histogram: MuiScopeHistogramSample(r: (0..<24).map { $0 * 3 }, g: (0..<24).map { $0 * 2 }, b: (0..<24).map { 48 - $0 }),
            waveformLuma: (0..<48).map { Double($0) / 48 },
            parade: MuiScopeParadeSample(r: (0..<24).map { Double($0) / 24 }, g: (0..<24).map { Double($0) / 24 * 0.8 }, b: (0..<24).map { Double($0) / 24 * 0.6 }),
            vectorscope: (0..<30).map { i in MuiVectorscopeSample(r: Double(i % 5) / 5, g: Double(i % 3) / 3, b: Double(i % 7) / 7) }
        ))
        .frame(width: 220)
    }
}

private struct BacklinksPanelDemo: View {
    var body: some View {
        MuiBacklinksPanel(links: [
            MuiBacklinkItem(id: "1", icon: "note.text", label: "Iceland trip journal", subtitle: "3 places"),
            MuiBacklinkItem(id: "2", icon: "rectangle.stack", label: "2026 Portfolio Board"),
        ])
        .frame(width: 220, height: 100)
    }
}

private struct VersionHistoryPanelDemo: View {
    var body: some View {
        MuiVersionHistoryPanel(versions: [
            MuiVersionItem(id: "1", label: "Current edit", timestampValue: Date(), current: true),
            MuiVersionItem(id: "2", label: "Before color grade", timestampValue: Date().addingTimeInterval(-3600)),
        ])
        .frame(width: 220, height: 140)
    }
}

private struct ThreadPanelDemo: View {
    @State private var draft = ""
    var body: some View {
        MuiThreadPanel(
            messages: [
                MuiThreadMessage(id: "1", author: "Alex", sentAt: Date().addingTimeInterval(-600), text: "Can we crop tighter?"),
                MuiThreadMessage(id: "2", author: "You", sentAt: Date().addingTimeInterval(-300), text: "Sure, on it.", own: true),
            ],
            draft: $draft
        )
        .frame(width: 220, height: 200)
    }
}
