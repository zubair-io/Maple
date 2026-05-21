// DetailPanel.swift — Right-side panel with Info + Develop tabs.
//
// Only mounted when the app is in Full-image mode. Browse mode drops the
// detail column entirely (AppShell renders a 2-column NavigationSplitView).
// Sliders disable when no session is active so opening the editor from a
// cold session doesn't jump the layout while the sidecar loads.
//
// Mirrors the React prototype's DetailPanel from src/web. Develop tab exposes
// all AdjustmentModel sliders; Info tab shows EXIF.

import SwiftUI
import MapleCore

// MARK: - DetailPanel

struct DetailPanel: View {
    /// The active editing session. `nil` when no image is selected — the
    /// panel stays visible with disabled controls so the layout doesn't jump.
    let session: EditSession?

    /// Whether the AppShell is currently in Full-image mode. Drives:
    /// - Bug 4: enter Full-image → auto-switch tab to Develop.
    /// - Bug 5: leave Full-image → auto-switch tab to Info.
    /// - Bug 8: in Browse, the Develop tab is hidden entirely (not disabled).
    /// Defaults to `false` for the iPhone TabView shell, where the panel is
    /// reached as its own root tab — there's no Browse/Full-image distinction
    /// at the panel level on phone, so the Develop tab stays visible.
    var isFullImage: Bool = false

    /// Default to Info — the spec + mockup put culling + file metadata first.
    /// Flips automatically on `isFullImage` transitions (see `.onChange` below).
    @State private var selectedTab: PanelTab = .info

    /// Nested in `DetailPanel` rather than file-scoped, but exposed by the
    /// outer type's namespace so `DetailPanelVM.tabForFullImage` (in
    /// `DetailPanel+VM.swift`) can return `DetailPanel.PanelTab` without
    /// leaking SwiftUI types.
    enum PanelTab { case info, develop }

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar — Develop is hidden in Browse mode (Bug 8). When the
            // segment isn't rendered, taps can't even reach it; this is the
            // "hidden, not disabled" requirement from the ticket.
            HStack(spacing: 0) {
                TabButton(title: "Info",    isSelected: selectedTab == .info)    { selectedTab = .info    }
                if isFullImage {
                    TabButton(title: "Develop", isSelected: selectedTab == .develop) { selectedTab = .develop }
                }
            }
            .background(MapleTokens.sidebar)

            Divider().overlay(MapleTokens.border)

            // Content
            ScrollView {
                switch selectedTab {
                case .info:    InfoTab(session: session)
                case .develop: DevelopTab(session: session)
                }
            }
            .background(MapleTokens.sidebar)
        }
        // Fill the detail column entirely so resizing doesn't reveal a gap
        // between the panel and the window edge. The column's own width is
        // capped in AppShell via navigationSplitViewColumnWidth.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.sidebar)
        // Auto-switch tabs when the AppShell crosses the Browse↔Full-image
        // boundary. Bugs 4 + 5: opening the editor lands on Develop, returning
        // to Browse lands on Info. The transition fires once per mode change,
        // so the user can still pick the other tab manually inside that mode
        // without us snapping it back.
        .onChange(of: isFullImage) { _, nowFullImage in
            selectedTab = DetailPanelVM.tabForFullImage(nowFullImage)
        }
    }
}

// MARK: - TabButton

struct TabButton: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                .foregroundStyle(isSelected ? MapleTokens.textMain : MapleTokens.textMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(isSelected ? MapleTokens.primary : Color.clear)
                .frame(height: 2)
        }
    }
}

// MARK: - InfoTab

struct InfoTab: View {
    let session: EditSession?

    /// EXIF dump loaded asynchronously when the session changes. Reading it
    /// inside `body` would either block the main thread (URL path uses
    /// `CGImageSourceCreateWithURL` which can hit disk) or, for sourceless
    /// PhotoKit/Self-Hosted assets, require an async `bytesProvider` call
    /// that can't happen synchronously inside a view body. We hop into a
    /// detached Task on `.task(id:)` and write the result back here.
    @State private var exif: [ImageMetadataReader.ExifEntry] = []

    var body: some View {
        VStack(alignment: .leading, spacing: MapleTokens.Spacing.sectionGap) {
            VStack(alignment: .leading, spacing: 6) {
                SectionHeader("File")
                InfoRow("Name", DetailPanelVM.nameDisplay(for: session?.asset))
            }

            if let tempText = DetailPanelVM.formatAsShotCCT(session?.asShotCCT) {
                VStack(alignment: .leading, spacing: 6) {
                    SectionHeader("As Shot")
                    InfoRow("Temp", tempText)
                    if let tintText = DetailPanelVM.formatAsShotTint(session?.asShotTint) {
                        InfoRow("Tint", tintText)
                    }
                }
            }

            // Full EXIF dump grouped by section. Sections render in the order
            // the reader produced them (Image → Camera → Exposure → GPS →
            // File) — see `ImageMetadataReader.exifEntries` for ordering.
            ForEach(DetailPanelVM.exifSections(from: exif), id: \.self) { section in
                VStack(alignment: .leading, spacing: 6) {
                    SectionHeader(section)
                    ForEach(exif.filter { $0.section == section }) { entry in
                        InfoRow(entry.label, entry.value)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                SectionHeader("Culling")
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Stars")
                            .font(MapleTokens.Typography.meta)
                            .foregroundStyle(MapleTokens.textMuted)
                        Spacer()
                        StarView(count: session?.culling.stars ?? 0, size: 14)
                            .opacity(session == nil ? 0.5 : 1)
                    }
                    HStack {
                        Text("Flag")
                            .font(MapleTokens.Typography.meta)
                            .foregroundStyle(MapleTokens.textMuted)
                        Spacer()
                        FlagBadge(flag: session?.culling.flag ?? .none)
                            .opacity(session == nil ? 0.5 : 1)
                    }
                }
                .padding(.horizontal, MapleTokens.Spacing.panelInset)
                .padding(.vertical, 4)
            }
        }
        .padding(.vertical, MapleTokens.Spacing.panelInset)
        // Reload EXIF whenever the session's asset changes — `task(id:)`
        // cancels the prior task on switch so we don't paint stale rows.
        .task(id: session?.asset.id) {
            await loadExif()
        }
    }

    /// Off-main EXIF read. Delegates to `DetailPanelVM.loadExif` for the
    /// actual bytes pull; this method only handles the @State write and the
    /// post-await identity check (the user may have switched assets while
    /// bytes were fetching).
    private func loadExif() async {
        guard let session else {
            exif = []
            return
        }
        let asset = session.asset
        let entries = await DetailPanelVM.loadExif(for: asset)
        guard session.asset.id == asset.id else { return }
        exif = entries
    }
}

struct InfoRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label; self.value = value
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(MapleTokens.Typography.meta)
                .foregroundStyle(MapleTokens.textMuted)
                .frame(width: 96, alignment: .trailing)
            Text(value)
                .font(MapleTokens.Typography.row)
                .foregroundStyle(MapleTokens.textMain)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(3)
                .textSelection(.enabled)
        }
        .padding(.horizontal, MapleTokens.Spacing.panelInset)
        .padding(.vertical, 4)
    }
}

struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title.uppercased())
            .font(MapleTokens.Typography.sectionHeader)
            .foregroundStyle(MapleTokens.textMuted)
            .tracking(1.4)
            .padding(.horizontal, MapleTokens.Spacing.panelInset)
            .padding(.bottom, 4)
    }
}

// MARK: - DevelopTab

struct DevelopTab: View {
    let session: EditSession?

    var body: some View {
        Group {
            if let session {
                ActiveDevelopTab(session: session)
            } else {
                DisabledDevelopTab()
            }
        }
    }
}

/// Develop tab rendered against a live session. Sliders are bindable to the
/// session's `@Observable` adjustment model.
private struct ActiveDevelopTab: View {
    @Bindable var session: EditSession

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button("Undo", systemImage: "arrow.uturn.backward") {
                    session.undo()
                }
                .disabled(!session.canUndo)

                Button("Redo", systemImage: "arrow.uturn.forward") {
                    session.redo()
                }
                .disabled(!session.canRedo)

                Spacer()

                Button("Reset", systemImage: "arrow.counterclockwise") {
                    session.resetToOriginal()
                }
            }
            .font(.caption)
            .foregroundStyle(MapleTokens.textMuted)
            .buttonStyle(.borderless)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider().overlay(MapleTokens.border)

            CollapsibleSection(title: "White Balance") {
                // Temperature: blue (cool source / cool render at low CCT)
                // → orange (warm source / warm render at high CCT). Default
                // 6500 K = D65, neutral. Mirrors ACR's slider visual.
                AdjustSlider("Temperature", value: $session.model.temperature,
                             range: AdjustmentModel.temperatureRange, format: "%.0f K",
                             colors: [.blue, .orange], defaultValue: 6500)
                // Tint: green (positive shift) → magenta (negative shift).
                // ACR convention is signed −100..+100 with 0 neutral.
                AdjustSlider("Tint", value: $session.model.tint, range: AdjustmentModel.tintRange,
                             colors: [.green, .pink])
                if let cct = session.asShotCCT, let tint = session.asShotTint {
                    HStack {
                        Spacer()
                        Button("As Shot") {
                            session.beginEdit()
                            session.model.temperature = cct
                            session.model.tint = tint
                        }
                        .font(.caption)
                        .buttonStyle(.borderless)
                        .foregroundStyle(MapleTokens.textMuted)
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 4)
                }
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Basic") {
                // Exposure crosses through neutral mid-gray; full range
                // black → gray → white reads as a luminance ramp.
                AdjustSlider("Exposure",   value: $session.model.exposure,   range: AdjustmentModel.exposureRange,
                             format: "%.2f EV",
                             colors: [.black, .gray, .white])
                // Contrast/Highlights/Whites: neutral → bright (pulling
                // the high end up). Shadows/Blacks: dark → mid-dark
                // (pulling the low end down).
                AdjustSlider("Contrast",   value: $session.model.contrast,   range: AdjustmentModel.contrastRange,
                             colors: [.gray, .white])
                AdjustSlider("Highlights", value: $session.model.highlights, range: AdjustmentModel.highlightsRange,
                             colors: [.gray, .white])
                AdjustSlider("Shadows",    value: $session.model.shadows,    range: AdjustmentModel.shadowsRange,
                             colors: [Color(hex: "#333333"), .gray])
                AdjustSlider("Whites",     value: $session.model.whites,     range: AdjustmentModel.whitesRange,
                             colors: [.gray, .white])
                AdjustSlider("Blacks",     value: $session.model.blacks,     range: AdjustmentModel.blacksRange,
                             colors: [.black, .gray])
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Presence") {
                // Vibrance / Saturation visually telegraph chroma push;
                // both run gray → red since red is the most distinctive
                // saturation cue in the typical mid-gray track. Clarity
                // / Texture are luminance-contrast operations, gray →
                // white. Dehaze cleans the haze tone (purple-gray) into
                // clean white.
                AdjustSlider("Vibrance",   value: $session.model.vibrance,   range: AdjustmentModel.vibranceRange,
                             colors: [.gray, Color(hex: "#FF6B6B")])
                AdjustSlider("Saturation", value: $session.model.saturation, range: AdjustmentModel.saturationRange,
                             colors: [.gray, Color(hex: "#FF4444")])
                AdjustSlider("Clarity",    value: $session.model.clarity,    range: AdjustmentModel.clarityRange,
                             colors: [.gray, .white])
                AdjustSlider("Texture",    value: $session.model.texture,    range: AdjustmentModel.textureRange,
                             colors: [.gray, .white])
                AdjustSlider("Dehaze",     value: $session.model.dehaze,     range: AdjustmentModel.dehazeRange,
                             colors: [Color(hex: "#8888AA"), .white])
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Detail") {
                // Sharpening + NR are intensity ramps — gray → white reads
                // as "more processing." Radius default 1.0 mirrors ACR's
                // raw-file capture-sharpening default (after the recent
                // f4e3ef7 commit dropped the ill-advised default of 5).
                AdjustSlider("Sharpen",    value: $session.model.sharpenAmount,  range: AdjustmentModel.sharpenAmountRange,
                             colors: [.gray, .white])
                AdjustSlider("Radius",     value: $session.model.sharpenRadius,  range: AdjustmentModel.sharpenRadiusRange,
                             format: "%.1f",
                             colors: [.gray, .white], defaultValue: 1.0)
                AdjustSlider("NR Lum",     value: $session.model.nrLuminance,    range: AdjustmentModel.nrLuminanceRange,
                             colors: [.gray, .white])
                AdjustSlider("NR Color",   value: $session.model.nrColor,        range: AdjustmentModel.nrColorRange,
                             colors: [.gray, .white], defaultValue: 25)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Develop tab rendered when no session is active. Sliders are bound to local
/// no-op state and disabled — the layout stays identical to the live variant.
private struct DisabledDevelopTab: View {
    // Dummy values so @State bindings exist. Never read by the user.
    @State private var z: Double = 0
    @State private var temp: Double = 5500

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button("Undo", systemImage: "arrow.uturn.backward") {}
                Button("Redo", systemImage: "arrow.uturn.forward") {}
                Spacer()
                Button("Reset", systemImage: "arrow.counterclockwise") {}
            }
            .font(.caption)
            .foregroundStyle(MapleTokens.textMuted)
            .buttonStyle(.borderless)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .disabled(true)

            Divider().overlay(MapleTokens.border)

            // Same gradient palette as ActiveDevelopTab so layout + visual
            // weight are identical when no session is loaded — the panel
            // doesn't jump between states.
            CollapsibleSection(title: "White Balance") {
                AdjustSlider("Temperature", value: $temp, range: AdjustmentModel.temperatureRange, format: "%.0f K",
                             colors: [.blue, .orange], defaultValue: 6500)
                AdjustSlider("Tint", value: $z, range: AdjustmentModel.tintRange,
                             colors: [.green, .pink])
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Basic") {
                AdjustSlider("Exposure",   value: $z, range: AdjustmentModel.exposureRange, format: "%.2f EV",
                             colors: [.black, .gray, .white])
                AdjustSlider("Contrast",   value: $z, range: AdjustmentModel.contrastRange,
                             colors: [.gray, .white])
                AdjustSlider("Highlights", value: $z, range: AdjustmentModel.highlightsRange,
                             colors: [.gray, .white])
                AdjustSlider("Shadows",    value: $z, range: AdjustmentModel.shadowsRange,
                             colors: [Color(hex: "#333333"), .gray])
                AdjustSlider("Whites",     value: $z, range: AdjustmentModel.whitesRange,
                             colors: [.gray, .white])
                AdjustSlider("Blacks",     value: $z, range: AdjustmentModel.blacksRange,
                             colors: [.black, .gray])
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Presence") {
                AdjustSlider("Vibrance",   value: $z, range: AdjustmentModel.vibranceRange,
                             colors: [.gray, Color(hex: "#FF6B6B")])
                AdjustSlider("Saturation", value: $z, range: AdjustmentModel.saturationRange,
                             colors: [.gray, Color(hex: "#FF4444")])
                AdjustSlider("Clarity",    value: $z, range: AdjustmentModel.clarityRange,
                             colors: [.gray, .white])
                AdjustSlider("Texture",    value: $z, range: AdjustmentModel.textureRange,
                             colors: [.gray, .white])
                AdjustSlider("Dehaze",     value: $z, range: AdjustmentModel.dehazeRange,
                             colors: [Color(hex: "#8888AA"), .white])
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Detail") {
                AdjustSlider("Sharpen",    value: $z, range: AdjustmentModel.sharpenAmountRange,
                             colors: [.gray, .white])
                AdjustSlider("Radius",     value: $z, range: AdjustmentModel.sharpenRadiusRange, format: "%.1f",
                             colors: [.gray, .white], defaultValue: 1.0)
                AdjustSlider("NR Lum",     value: $z, range: AdjustmentModel.nrLuminanceRange,
                             colors: [.gray, .white])
                AdjustSlider("NR Color",   value: $z, range: AdjustmentModel.nrColorRange,
                             colors: [.gray, .white], defaultValue: 25)
            }
        }
        .padding(.vertical, 4)
        .disabled(true)
        .opacity(0.5)
    }
}

// MARK: - CollapsibleSection

struct CollapsibleSection<Content: View>: View {
    let title: String
    @State private var expanded = true
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            Button(action: { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } }) {
                HStack {
                    SectionHeader(title)
                    Spacer()
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(MapleTokens.textMuted)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(spacing: 6) { content() }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
            }
        }
    }
}

// MARK: - AdjustSlider

struct AdjustSlider: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let format: String
    /// Linear-gradient track painted behind the system slider. Single
    /// element renders a flat color; two+ elements render the gradient
    /// left-to-right. Defaults to a neutral gray→white "intensity"
    /// gradient — appropriate for any 0..N or "more is brighter" slider.
    let colors: [Color]
    /// Snapped-to value on a double-tap reset. Defaults to 0 (matches
    /// every range that crosses zero); WB Temperature passes 6500 etc.
    let defaultValue: Double

    init(
        _ label: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        format: String = "%.0f",
        colors: [Color] = [.gray, .white],
        defaultValue: Double = 0
    ) {
        self.label = label
        self._value = value
        self.range = range
        self.format = format
        self.colors = colors
        self.defaultValue = defaultValue
    }

    /// Stable accessibility identifier derived from `label`. Delegates to
    /// `DetailPanelVM.sliderAccessibilityID` so the slug rule is unit-testable.
    private var accessibilityID: String {
        DetailPanelVM.sliderAccessibilityID(for: label)
    }

    var body: some View {
        // Two rows:
        //   1. Label (left-aligned) + Value (right-aligned, monospaced).
        //   2. Gradient track + system slider stacked.
        // Gives the slider the full panel width to play with — the
        // single-row layout had to compete for horizontal space with two
        // text columns and felt cramped at iPad/macOS-narrow widths.
        VStack(spacing: 2) {
            HStack {
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(MapleTokens.textMain)
                Spacer()
                Text(String(format: format, value))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(MapleTokens.textMain)
            }

            // Gradient track + system slider with clear tint stacked together.
            // The gradient signals what direction the slider is moving toward
            // (e.g. blue→orange for Temperature so the user can SEE that left
            // = cooling, right = warming before they touch it). Capsule clip
            // matches the slider's visual lozenge. Opacity 0.6 keeps the
            // gradient secondary to the slider's thumb.
            ZStack(alignment: .leading) {
                LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
                    .frame(height: 4)
                    .clipShape(Capsule())
                    .opacity(0.6)

                Slider(value: $value, in: range)
                    .tint(.clear)
                    .controlSize(.mini)
                    .accessibilityIdentifier(accessibilityID)
            }
            // Double-tap snaps back to `defaultValue`. Mirrors the reference
            // Maple's UX affordance: a quick way back to "no edit" without
            // hunting for the precise zero on a continuous track.
            .onTapGesture(count: 2) {
                withAnimation(.easeInOut(duration: 0.15)) {
                    value = defaultValue
                }
            }
        }
    }
}

// MARK: - Previews
//
// Issue #139 — the three-column-shell's right-hand detail panel. Two
// meaningful states: `nil` session (empty placeholder) and a populated
// session driven by `EditSession.preview()`. The Info tab's EXIF table
// will be empty because the preview asset has no on-disk bytes; the
// Develop tab renders all sliders against the model defaults.

#Preview("Loaded — Info tab") {
    DetailPanel(session: EditSession.preview())
        .frame(width: 320, height: 700)
}

#Preview("Loaded — full-image variant") {
    DetailPanel(session: EditSession.preview(), isFullImage: true)
        .frame(width: 320, height: 700)
}

#Preview("Empty (no session)") {
    DetailPanel(session: nil)
        .frame(width: 320, height: 700)
}
