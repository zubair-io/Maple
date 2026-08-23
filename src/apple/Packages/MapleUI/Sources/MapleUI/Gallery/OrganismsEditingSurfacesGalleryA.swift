// OrganismsEditingSurfacesGalleryA.swift — Organisms §4.5 (Editing
// surfaces), first five: Image Canvas, Crop Overlay, Crop Toolbar, Control
// Surface, Mobile Control Bar. See OrganismsGallerySection.swift for the
// tab this feeds into, and OrganismsEditingSurfacesGalleryB.swift for the
// remaining four.

import SwiftUI

struct OrganismsEditingSurfacesGalleryA: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            GallerySpecimenCard(name: "Image Canvas", purpose: "Zoom, pan, before/after, render", builtFrom: "Canvas Surface, Preview Image, Crop Overlay") { ImageCanvasDemo() }
            GallerySpecimenCard(name: "Crop Overlay", purpose: "Draggable crop with grid and mask", builtFrom: "Drag Bar, Icon") { CropOverlayDemo() }
            GallerySpecimenCard(name: "Crop Toolbar", purpose: "Aspect presets and straighten", builtFrom: "Chip Row, Drag Bar, Button") { CropToolbarDemo() }
            GallerySpecimenCard(name: "Control Surface", purpose: "Panel for the armed tool", builtFrom: "Tabs, Living Slider, Chip Row, Value Chip") { ControlSurfaceDemo() }
            GallerySpecimenCard(name: "Mobile Control Bar", purpose: "Phone bottom control stack", builtFrom: "Tool Dock, Control Surface, Tabs") { MobileControlBarDemo() }
        }
    }
}

private struct ImageCanvasDemo: View {
    @State private var cropRect = MuiCropRect(x: 30, y: 20, width: 160, height: 100)
    @State private var showBefore = false
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            MuiSegmentedToggle(
                options: [MuiSegmentedOption(value: "after", label: "After"), MuiSegmentedOption(value: "before", label: "Before")],
                value: Binding(get: { showBefore ? "before" : "after" }, set: { showBefore = $0 == "before" })
            )
            MuiImageCanvas(url: nil, showBefore: showBefore, cropMode: true, cropRect: $cropRect)
                .frame(width: 260, height: 170)
        }
    }
}

private struct CropOverlayDemo: View {
    @State private var rect = MuiCropRect(x: 30, y: 20, width: 160, height: 100)
    var body: some View {
        ZStack {
            MuiTokens.imageCanvas
            MuiCropOverlay(containerSize: CGSize(width: 240, height: 160), rect: $rect)
        }
        .frame(width: 240, height: 160)
    }
}

private struct CropToolbarDemo: View {
    @State private var aspect = "16:9"
    @State private var angle = 4.0
    var body: some View {
        MuiCropToolbar(aspect: $aspect, angle: $angle)
    }
}

private struct ControlSurfaceDemo: View {
    @State private var activeTab = "light"
    @State private var sliders: [MuiControlSurfaceSlider] = [
        MuiControlSurfaceSlider(id: "exposure", label: "Exposure", value: 0.3, min: -5, max: 5, step: 0.1, unit: "EV"),
        MuiControlSurfaceSlider(id: "contrast", label: "Contrast", value: 12, min: -100, max: 100),
    ]
    var body: some View {
        MuiControlSurface(
            tabs: [MuiTab(id: "light", label: "Light"), MuiTab(id: "color", label: "Color")],
            activeTabId: $activeTab, sliders: sliders,
            sliderChanged: { id, value in
                if let idx = sliders.firstIndex(where: { $0.id == id }) {
                    let s = sliders[idx]
                    sliders[idx] = MuiControlSurfaceSlider(id: id, label: s.label, value: value, min: s.min, max: s.max, step: s.step, unit: s.unit)
                }
            }
        )
        .frame(width: 260, height: 220)
    }
}

private struct MobileControlBarDemo: View {
    @State private var activeTool: String? = "adjust"
    @State private var activeTab = "light"
    var body: some View {
        MuiMobileControlBar(
            tools: [
                MuiMobileControlBarTool(id: "crop", icon: "crop", label: "Crop"),
                MuiMobileControlBarTool(id: "adjust", icon: "slider.horizontal.3", label: "Adjust"),
            ],
            activeToolId: $activeTool,
            tabs: [MuiTab(id: "light", label: "Light")], activeTabId: $activeTab,
            sliders: [MuiControlSurfaceSlider(id: "exposure", label: "Exposure", value: 0.2, min: -5, max: 5, step: 0.1)]
        )
        .frame(width: 300)
    }
}
