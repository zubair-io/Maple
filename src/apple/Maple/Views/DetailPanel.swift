// DetailPanel.swift — Right-side panel with Info + Develop tabs.
//
// Per mockup (docs/photo_app_mockup_v2.html, lines ~49-71), the panel is
// always part of the layout — the sliders simply disable when no session is
// active. Passing a nil session preserves the tab bar + section headers so
// switching back in is instant.
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

    /// Default to Info — the spec + mockup put culling + file metadata first.
    /// Develop becomes the active tab once the user opens the editor
    /// (double-click an image in Browse mode).
    @State private var selectedTab: PanelTab = .info
    /// When a session becomes non-nil (i.e. the editor opened), auto-switch
    /// to Develop. Going back to Browse doesn't auto-flip back to Info — the
    /// user may still want to see their last adjustments.
    @State private var lastHadSession: Bool = false

    enum PanelTab { case info, develop }

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            HStack(spacing: 0) {
                TabButton(title: "Info",    isSelected: selectedTab == .info)    { selectedTab = .info    }
                TabButton(title: "Develop", isSelected: selectedTab == .develop) { selectedTab = .develop }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("File")
            // Name = filename with extension. Path = parent directory only.
            InfoRow("Name", session?.asset.primaryURL?.lastPathComponent
                         ?? session?.asset.displayName
                         ?? "—")
            InfoRow("Path", session?.asset.primaryURL?
                                .deletingLastPathComponent().path ?? "—")

            if let cct = session?.asShotCCT {
                Divider().overlay(MapleTokens.border).padding(.vertical, 4)
                SectionHeader("As Shot")
                InfoRow("Temp", String(format: "%.0f K", cct))
                if let t = session?.asShotTint {
                    InfoRow("Tint", String(format: "%.0f", t))
                }
            }

            Divider().overlay(MapleTokens.border).padding(.vertical, 4)

            SectionHeader("Culling")
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Stars").foregroundStyle(MapleTokens.textMuted).font(.system(size: 11))
                    Spacer()
                    StarView(count: session?.culling.stars ?? 0)
                        .opacity(session == nil ? 0.5 : 1)
                }
                HStack {
                    Text("Flag").foregroundStyle(MapleTokens.textMuted).font(.system(size: 11))
                    Spacer()
                    FlagBadge(flag: session?.culling.flag ?? .none)
                        .opacity(session == nil ? 0.5 : 1)
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 12)
    }
}

struct InfoRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label; self.value = value
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.textMuted)
                .frame(width: 60, alignment: .trailing)
            Text(value)
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.textMain)
                .lineLimit(2)
        }
        .padding(.horizontal, 12)
    }
}

struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(MapleTokens.textMuted)
            .tracking(1.2)
            .padding(.horizontal, 12)
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
                AdjustSlider("Temperature", value: $session.model.temperature,
                             range: 2000...12000, format: "%.0f K")
                AdjustSlider("Tint", value: $session.model.tint, range: -100...100)
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
                AdjustSlider("Exposure",   value: $session.model.exposure,   range: -4...4, format: "%.2f EV")
                AdjustSlider("Contrast",   value: $session.model.contrast,   range: -100...100)
                AdjustSlider("Highlights", value: $session.model.highlights, range: -100...100)
                AdjustSlider("Shadows",    value: $session.model.shadows,    range: -100...100)
                AdjustSlider("Whites",     value: $session.model.whites,     range: -100...100)
                AdjustSlider("Blacks",     value: $session.model.blacks,     range: -100...100)
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Presence") {
                AdjustSlider("Vibrance",   value: $session.model.vibrance,   range: -100...100)
                AdjustSlider("Saturation", value: $session.model.saturation, range: -100...100)
                AdjustSlider("Clarity",    value: $session.model.clarity,    range: -100...100)
                AdjustSlider("Texture",    value: $session.model.texture,    range: -100...100)
                AdjustSlider("Dehaze",     value: $session.model.dehaze,     range: -100...100)
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Detail") {
                AdjustSlider("Sharpen",    value: $session.model.sharpenAmount,  range: 0...150)
                AdjustSlider("Radius",     value: $session.model.sharpenRadius,  range: 0.5...3, format: "%.1f")
                AdjustSlider("NR Lum",     value: $session.model.nrLuminance,    range: 0...100)
                AdjustSlider("NR Color",   value: $session.model.nrColor,        range: 0...100)
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

            CollapsibleSection(title: "White Balance") {
                AdjustSlider("Temperature", value: $temp, range: 2000...12000, format: "%.0f K")
                AdjustSlider("Tint", value: $z, range: -100...100)
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Basic") {
                AdjustSlider("Exposure",   value: $z, range: -4...4, format: "%.2f EV")
                AdjustSlider("Contrast",   value: $z, range: -100...100)
                AdjustSlider("Highlights", value: $z, range: -100...100)
                AdjustSlider("Shadows",    value: $z, range: -100...100)
                AdjustSlider("Whites",     value: $z, range: -100...100)
                AdjustSlider("Blacks",     value: $z, range: -100...100)
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Presence") {
                AdjustSlider("Vibrance",   value: $z, range: -100...100)
                AdjustSlider("Saturation", value: $z, range: -100...100)
                AdjustSlider("Clarity",    value: $z, range: -100...100)
                AdjustSlider("Texture",    value: $z, range: -100...100)
                AdjustSlider("Dehaze",     value: $z, range: -100...100)
            }
            Divider().overlay(MapleTokens.border)
            CollapsibleSection(title: "Detail") {
                AdjustSlider("Sharpen",    value: $z, range: 0...150)
                AdjustSlider("Radius",     value: $z, range: 0.5...3, format: "%.1f")
                AdjustSlider("NR Lum",     value: $z, range: 0...100)
                AdjustSlider("NR Color",   value: $z, range: 0...100)
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

    init(_ label: String, value: Binding<Double>, range: ClosedRange<Double>, format: String = "%.0f") {
        self.label = label
        self._value = value
        self.range = range
        self.format = format
    }

    /// Stable accessibility identifier derived from `label` — lowercased,
    /// spaces collapsed to dashes. "NR Lum" → `slider-nr-lum`. See
    /// docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.
    private var accessibilityID: String {
        let slug = label
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
        return "slider-\(slug)"
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(MapleTokens.textMuted)
                .frame(width: 70, alignment: .trailing)

            Slider(value: $value, in: range)
                .tint(MapleTokens.primary)
                .controlSize(.mini)
                .accessibilityIdentifier(accessibilityID)

            Text(String(format: format, value))
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(MapleTokens.textMain)
                .frame(width: 45, alignment: .trailing)
        }
    }
}
