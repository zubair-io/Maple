// OrganismsPanelsGalleryA.swift — Organisms §4.3 (Inspectors & panels),
// first half: Inspector Panel, Info Panel, Enrichment Panel, Adjustments
// Panel, Color Grading Panel, HSL Panel, Tone Curve Panel. See
// OrganismsGallerySection.swift for the tab this feeds into, and
// OrganismsPanelsGalleryB.swift for the remaining six.

import SwiftUI

struct OrganismsPanelsGalleryA: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            inspectorPanelCard
            infoPanelCard
            enrichmentPanelCard
            adjustmentsPanelCard
            colorGradingPanelCard
            hslPanelCard
            toneCurvePanelCard
        }
    }

    private var inspectorPanelCard: some View {
        GallerySpecimenCard(name: "Inspector Panel", purpose: "Tabbed right-side detail region", builtFrom: "Tabs, Page Header") {
            InspectorPanelDemo()
        }
    }

    private var infoPanelCard: some View {
        GallerySpecimenCard(name: "Info Panel", purpose: "Full asset metadata", builtFrom: "Label-Value Grid, Histogram, Keyword Row, Rating & Flags, Inline Rename Field") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                InfoPanelDemo()
                VStack(alignment: .leading, spacing: 2) {
                    MuiText("Loading", variant: .toolLabel, color: .muted)
                    MuiInfoPanel(loading: true, filename: .constant(""), metadata: [], keywords: [])
                        .frame(width: 160, height: 220)
                        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
                }
            }
        }
    }

    private var enrichmentPanelCard: some View {
        GallerySpecimenCard(name: "Enrichment Panel", purpose: "AI-derived fields with live status", builtFrom: "Description Field, Faces Row, Place Row, Transcript Block, Vision Row, Badge") {
            EnrichmentPanelDemo()
        }
    }

    private var adjustmentsPanelCard: some View {
        GallerySpecimenCard(name: "Adjustments Panel", purpose: "All tool-group sliders", builtFrom: "Living Slider, Collapsible, Tabs") {
            AdjustmentsPanelDemo()
        }
    }

    private var colorGradingPanelCard: some View {
        GallerySpecimenCard(name: "Color Grading Panel", purpose: "Shadows / mids / highlights", builtFrom: "Color Wheel, Living Slider") {
            ColorGradingPanelDemo()
        }
    }

    private var hslPanelCard: some View {
        GallerySpecimenCard(name: "HSL Panel", purpose: "Per-band hue / sat / luminance", builtFrom: "Chip Row, Living Slider") {
            HslPanelDemo()
        }
    }

    private var toneCurvePanelCard: some View {
        GallerySpecimenCard(name: "Tone Curve Panel", purpose: "Channel curve plus parametrics", builtFrom: "Tabs, Curve Plot, Living Slider") {
            ToneCurvePanelDemo()
        }
    }
}

private struct InspectorPanelDemo: View {
    @State private var activeTab = "info"
    var body: some View {
        MuiInspectorPanel(
            title: "IMG_0042.dng",
            tabs: [MuiTab(id: "info", label: "Info"), MuiTab(id: "edit", label: "Edit")],
            activeTabId: $activeTab
        ) {
            MuiText(activeTab == "info" ? "Info body." : "Edit body.", variant: .body, color: .muted).padding(MuiTokens.spacingMd)
        }
        .frame(width: 240, height: 160)
    }
}

private struct InfoPanelDemo: View {
    @State private var filename = "IMG_0042.dng"
    @State private var rating = 4
    @State private var flag: MuiRatingFlagState = .pick
    var body: some View {
        MuiInfoPanel(
            filename: $filename,
            metadata: [MuiLabelValueRow(label: "Camera", value: "Sony A7 IV"), MuiLabelValueRow(label: "ISO", value: "400")],
            histogram: MuiInfoPanelHistogram(r: (0..<24).map { $0 * 3 }, g: (0..<24).map { $0 * 2 }, b: (0..<24).map { 48 - $0 }),
            keywords: [MuiChip(id: "1", label: "Sunset")],
            rating: $rating,
            flag: $flag
        )
        .frame(width: 220, height: 280)
    }
}

private struct EnrichmentPanelDemo: View {
    @State private var description = "A lone hiker crosses a black-sand beach at dusk."
    @State private var place = "Reynisfjara, Iceland"
    @State private var selectedPerson: String?
    var body: some View {
        MuiEnrichmentPanel(
            description: $description,
            descriptionStatus: .done,
            people: [MuiChip(id: "1", label: "Alex")],
            place: $place,
            placeOverridden: true,
            visionLabels: [MuiChip(id: "1", label: "Beach")],
            selectedPersonId: $selectedPerson
        )
        .frame(width: 260, height: 340)
    }
}

private struct AdjustmentsPanelDemo: View {
    @State private var activeTab = "basic"
    @State private var values: [String: Double] = ["exposure": 0.3, "contrast": 12, "temp": 5500]
    var body: some View {
        MuiAdjustmentsPanel(
            tabs: [MuiAdjustmentTab(id: "basic", label: "Basic", groups: [MuiAdjustmentsPanel.lightGroup, MuiAdjustmentsPanel.colorGroup])],
            values: values,
            activeTabId: $activeTab,
            valueChanged: { id, value in values[id] = value }
        )
        .frame(width: 260, height: 340)
    }
}

private struct ColorGradingPanelDemo: View {
    @State private var shadows = MuiColorWheelValue(hue: 210, saturation: 20)
    @State private var shadowsLuma = 0.0
    @State private var mids = MuiColorWheelValue(hue: 0, saturation: 0)
    @State private var midsLuma = 0.0
    @State private var highlights = MuiColorWheelValue(hue: 40, saturation: 15)
    @State private var highlightsLuma = 0.0
    @State private var blending = 50.0
    @State private var balance = 0.0
    var body: some View {
        MuiColorGradingPanel(
            shadows: $shadows, shadowsLuminance: $shadowsLuma,
            midtones: $mids, midtonesLuminance: $midsLuma,
            highlights: $highlights, highlightsLuminance: $highlightsLuma,
            blending: $blending, balance: $balance
        )
        .frame(width: 280, height: 260)
    }
}

private struct HslPanelDemo: View {
    @State private var active = "red"
    @State private var values: [String: MuiHslBandValue] = ["red": MuiHslBandValue(hue: 10, saturation: -5, luminance: 0)]
    var body: some View {
        MuiHslPanel(values: values, activeBandId: $active, valueChanged: { band, field, value in
            var current = values[band] ?? MuiHslBandValue()
            switch field {
            case .hue: current = MuiHslBandValue(hue: value, saturation: current.saturation, luminance: current.luminance)
            case .saturation: current = MuiHslBandValue(hue: current.hue, saturation: value, luminance: current.luminance)
            case .luminance: current = MuiHslBandValue(hue: current.hue, saturation: current.saturation, luminance: value)
            }
            values[band] = current
        })
        .frame(width: 260, height: 200)
    }
}

private struct ToneCurvePanelDemo: View {
    @State private var points: [String: [MuiCurvePoint]] = ["rgb": [MuiCurvePoint(x: 0, y: 0), MuiCurvePoint(x: 0.5, y: 0.58), MuiCurvePoint(x: 1, y: 1)]]
    @State private var highlights = 0.0
    @State private var lights = 0.0
    @State private var darks = 0.0
    @State private var shadows = 0.0
    @State private var activeChannel = "rgb"
    var body: some View {
        MuiToneCurvePanel(
            points: points,
            highlights: $highlights, lights: $lights, darks: $darks, shadows: $shadows,
            activeChannelId: $activeChannel,
            pointsChanged: { channel, next in points[channel] = next }
        )
        .frame(width: 260, height: 420)
    }
}
