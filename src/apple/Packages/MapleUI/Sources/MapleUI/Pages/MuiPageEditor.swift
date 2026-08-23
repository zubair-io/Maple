// MuiPageEditor.swift — Maple UI Pages (unified-component-catalog.md §6).
// Split Layout hosting Image Canvas, Tool Dock, Control Surface,
// Adjustments Panel, Inspector Panel, and Filmstrip — the editor shell.
//
// Layout: Tool Dock rides the Sidebar region (a vertical tool-group
// switcher); Center stacks the Image Canvas over a compact Control
// Surface for whichever tool is armed, with the Filmstrip pinned to the
// very bottom; Detail hosts an Inspector Panel whose "Adjust" tab is the
// full Adjustments Panel (every tool group, not just the armed one) and
// whose "Info" tab is a plain metadata readout.
//
// Cross-organism wiring that's genuinely new at this tier: Tool Dock's
// selection decides both whether crop mode is armed on the canvas and
// which tab (if any) the compact Control Surface shows; and — the
// important one — Control Surface and the Adjustments Panel both write
// into one shared `values` map, so nudging Exposure from the compact
// per-tool panel and nudging it from the full Adjustments Panel converge
// on the same number, same as two views of one sidecar in the real app.
// `MuiPageEditor.applySliderChange` is the pure reducer behind that
// convergence.

import SwiftUI

public struct MuiPageEditorPhoto: Identifiable, Sendable {
    public let id: String
    public let url: URL?
    public let alt: String

    public init(id: String, url: URL?, alt: String) {
        self.id = id
        self.url = url
        self.alt = alt
    }
}

public struct MuiPageEditor: View {
    public let photos: [MuiPageEditorPhoto]
    public let adjustmentTabs: [MuiAdjustmentTab]

    @State private var activePhotoId: String?
    @State private var activeToolId: String? = "light"
    @State private var cropRect = MuiCropRect(x: 20, y: 20, width: 200, height: 140)
    @State private var controlTabId = "light"
    @State private var adjustmentsTabId = "light"
    @State private var inspectorTabId = "adjust"
    @State private var values: [String: Double] = MuiPageEditor.defaultValues

    public init(
        photos: [MuiPageEditorPhoto] = MuiPageEditor.defaultPhotos,
        adjustmentTabs: [MuiAdjustmentTab] = MuiPageEditor.defaultAdjustmentTabs
    ) {
        self.photos = photos
        self.adjustmentTabs = adjustmentTabs
        self._activePhotoId = State(initialValue: photos.first?.id)
    }

    private static let toolEntries: [MuiToolDockEntry] = [
        .item(MuiToolDockItem(id: "crop", icon: "crop", label: "Crop")),
        .item(MuiToolDockItem(id: "light", icon: "sun.max", label: "Light")),
        .item(MuiToolDockItem(id: "color", icon: "paintpalette", label: "Color")),
    ]

    private var activePhotoUrl: URL? {
        photos.first(where: { $0.id == activePhotoId })?.url
    }

    private var controlSliders: [MuiControlSurfaceSlider] {
        guard let tab = adjustmentTabs.first(where: { $0.id == controlTabId }) else { return [] }
        return tab.groups.flatMap(\.sliders).map { slider in
            MuiControlSurfaceSlider(
                id: slider.id, label: slider.label, value: values[slider.id] ?? 0,
                min: slider.min, max: slider.max, step: slider.step, unit: slider.unit
            )
        }
    }

    public var body: some View {
        MuiSplitLayout {
            MuiToolDock(entries: Self.toolEntries, activeId: $activeToolId, toolSelected: handleToolSelected)
                .padding(MuiTokens.spacingSm)
        } center: {
            VStack(spacing: 0) {
                MuiImageCanvas(url: activePhotoUrl, cropMode: Self.cropModeActive(toolId: activeToolId), cropRect: $cropRect)
                    .frame(maxHeight: .infinity)

                if let controlTabId = Self.armedControlTab(toolId: activeToolId) {
                    MuiDivider()
                    MuiControlSurface(
                        tabs: adjustmentTabs.map { MuiTab(id: $0.id, label: $0.label) },
                        activeTabId: Binding(get: { controlTabId }, set: { self.controlTabId = $0 }),
                        sliders: controlSliders,
                        sliderChanged: { id, value in values = Self.applySliderChange(values, id: id, value: value) }
                    )
                    .padding(MuiTokens.spacingMd)
                    .frame(height: 160)
                }

                MuiDivider()
                MuiFilmstrip(
                    items: photos.map { MuiFilmstripItem(id: $0.id, url: $0.url, alt: $0.alt) },
                    activeId: $activePhotoId
                )
                .frame(height: 88)
            }
        } detail: {
            MuiInspectorPanel(title: "Adjustments", tabs: [MuiTab(id: "adjust", label: "Adjust"), MuiTab(id: "info", label: "Info")], showBack: false, activeTabId: $inspectorTabId) {
                if inspectorTabId == "adjust" {
                    MuiAdjustmentsPanel(
                        tabs: adjustmentTabs,
                        values: values,
                        activeTabId: $adjustmentsTabId,
                        valueChanged: { id, value in values = Self.applySliderChange(values, id: id, value: value) }
                    )
                } else {
                    infoTab
                }
            }
        }
        .background(MuiTokens.bg)
    }

    private var infoTab: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            MuiText(photos.first(where: { $0.id == activePhotoId })?.alt ?? "No photo selected", variant: .rowLabel)
            MuiText("Hasselblad L3D-100c · 100MP", variant: .body, color: .muted)
        }
        .padding(MuiTokens.spacingMd)
    }

    private func handleToolSelected(_ toolId: String) {
        controlTabId = Self.armedControlTab(toolId: toolId) ?? controlTabId
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// Crop mode is armed exactly while the Crop tool is selected.
    public static func cropModeActive(toolId: String?) -> Bool {
        toolId == "crop"
    }

    /// The Control Surface tab to show for the armed tool — `nil` collapses
    /// the compact panel entirely (the Crop tool has nothing to slide; its
    /// controls live directly on the canvas overlay).
    public static func armedControlTab(toolId: String?) -> String? {
        switch toolId {
        case "light": return "light"
        case "color": return "color"
        default: return nil
        }
    }

    /// The shared slider-value map after a single id/value edit — the same
    /// map Control Surface and the Adjustments Panel both read from and
    /// write to, so an edit from either surface is visible on the other.
    public static func applySliderChange(_ values: [String: Double], id: String, value: Double) -> [String: Double] {
        var next = values
        next[id] = value
        return next
    }

    // MARK: - Default mock data

    public static let defaultPhotos: [MuiPageEditorPhoto] = [
        MuiPageEditorPhoto(id: "1", url: nil, alt: "IMG_0401.dng — Glacier lagoon at dawn"),
        MuiPageEditorPhoto(id: "2", url: nil, alt: "IMG_0402.dng — Basalt sea stacks"),
        MuiPageEditorPhoto(id: "3", url: nil, alt: "IMG_0417.dng — Northern lights over a farmhouse"),
        MuiPageEditorPhoto(id: "4", url: nil, alt: "IMG_0455.dng — Black-sand beach panorama"),
    ]

    public static let defaultValues: [String: Double] = [
        "exposure": 0.3, "contrast": 12, "highlights": -18, "shadows": 22, "whites": 0, "blacks": 0,
        "temp": 5200, "tint": 4, "vibrance": 10, "saturation": 0,
    ]

    public static let defaultAdjustmentTabs: [MuiAdjustmentTab] = [
        MuiAdjustmentTab(id: "light", label: "Light", groups: [
            MuiAdjustmentGroup(id: "basic", label: "Basic", sliders: [
                MuiAdjustmentSlider(id: "exposure", label: "Exposure", min: -5, max: 5, step: 0.1, unit: "EV", bipolar: true),
                MuiAdjustmentSlider(id: "contrast", label: "Contrast", min: -100, max: 100, bipolar: true),
                MuiAdjustmentSlider(id: "highlights", label: "Highlights", min: -100, max: 100, bipolar: true),
                MuiAdjustmentSlider(id: "shadows", label: "Shadows", min: -100, max: 100, bipolar: true),
                MuiAdjustmentSlider(id: "whites", label: "Whites", min: -100, max: 100, bipolar: true),
                MuiAdjustmentSlider(id: "blacks", label: "Blacks", min: -100, max: 100, bipolar: true),
            ]),
        ]),
        MuiAdjustmentTab(id: "color", label: "Color", groups: [
            MuiAdjustmentGroup(id: "wb", label: "White Balance", sliders: [
                MuiAdjustmentSlider(id: "temp", label: "Temp", min: 2000, max: 10000, step: 50, unit: "K"),
                MuiAdjustmentSlider(id: "tint", label: "Tint", min: -100, max: 100, bipolar: true),
            ]),
            MuiAdjustmentGroup(id: "presence", label: "Presence", sliders: [
                MuiAdjustmentSlider(id: "vibrance", label: "Vibrance", min: -100, max: 100, bipolar: true),
                MuiAdjustmentSlider(id: "saturation", label: "Saturation", min: -100, max: 100, bipolar: true),
            ]),
        ]),
    ]
}

#Preview("MuiPageEditor") {
    MuiPageEditor()
        .frame(width: 900, height: 560)
}
