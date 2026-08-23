// MuiExportModal.swift — Maple UI Organisms · Modals (unified-component-
// catalog.md §4.4). Format/size/quality/color-space export dialog, built
// on Overlay Shell from Segmented Toggle (format + color space pickers),
// Form Field (quality), Progress, and Banner. Presentational: the host owns
// the export request lifecycle and feeds `exporting`/`progress`/
// `resultBanner` back in as the job runs.

import SwiftUI

public struct MuiExportSettings: Sendable {
    public let format: String
    public let quality: Int
    public let colorSpace: String
}

public struct MuiExportResultBanner: Sendable {
    public let message: String
    public let variant: MuiBannerVariant

    public init(message: String, variant: MuiBannerVariant) {
        self.message = message
        self.variant = variant
    }
}

public struct MuiExportModal: View {
    public let isPresented: Bool
    public let contained: Bool
    public let formatOptions: [MuiSegmentedOption]
    public let colorSpaceOptions: [MuiSegmentedOption]
    @Binding public var format: String
    @Binding public var quality: Int
    @Binding public var colorSpace: String
    public let exporting: Bool
    public let progress: Double
    public let resultBanner: MuiExportResultBanner?
    public let exportRequested: ((MuiExportSettings) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        formatOptions: [MuiSegmentedOption],
        colorSpaceOptions: [MuiSegmentedOption],
        format: Binding<String>,
        quality: Binding<Int>,
        colorSpace: Binding<String>,
        exporting: Bool = false,
        progress: Double = 0,
        resultBanner: MuiExportResultBanner? = nil,
        exportRequested: ((MuiExportSettings) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.formatOptions = formatOptions
        self.colorSpaceOptions = colorSpaceOptions
        self._format = format
        self._quality = quality
        self._colorSpace = colorSpace
        self.exporting = exporting
        self.progress = progress
        self.resultBanner = resultBanner
        self.exportRequested = exportRequested
        self.dismissed = dismissed
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Export", contained: contained) {
            MuiText("Export", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                labeledSegment("Format", options: formatOptions, value: $format)
                labeledSegment("Color space", options: colorSpaceOptions, value: $colorSpace)
                MuiFormField(
                    label: "Quality", value: Binding(get: { "\(quality)" }, set: { commitQuality($0) }),
                    numeric: MuiInputNumericConfig(min: 1, max: 100, step: 1)
                )
                if exporting {
                    MuiProgress(shape: .bar, value: progress, label: "\(Int(progress))%")
                }
                if let resultBanner {
                    MuiBanner(variant: resultBanner.variant, message: resultBanner.message)
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Export", variant: .primary, isLoading: exporting, disabled: exporting) { confirmExport() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private func labeledSegment(_ label: String, options: [MuiSegmentedOption], value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            MuiText(label, variant: .toolLabel, color: .muted)
            MuiSegmentedToggle(options: options, value: value)
        }
    }

    private func commitQuality(_ raw: String) {
        quality = Self.clampedQuality(raw: raw, fallback: quality)
    }

    private func confirmExport() {
        exportRequested?(MuiExportSettings(format: format, quality: quality, colorSpace: colorSpace))
    }

    /// Parses and clamps a raw quality string into `1...100` — `fallback`
    /// when the string isn't a valid integer. Public + static so this is
    /// unit-testable without rendering a view.
    public static func clampedQuality(raw: String, fallback: Int) -> Int {
        guard let parsed = Int(raw) else { return fallback }
        return min(100, max(1, parsed))
    }
}

#Preview("MuiExportModal") {
    struct Demo: View {
        @State private var open = false
        @State private var format = "jpeg"
        @State private var quality = 90
        @State private var colorSpace = "srgb"
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Export", variant: .primary) { open = true }
                MuiExportModal(
                    isPresented: open,
                    formatOptions: [MuiSegmentedOption(value: "jpeg", label: "JPEG"), MuiSegmentedOption(value: "tiff", label: "TIFF")],
                    colorSpaceOptions: [MuiSegmentedOption(value: "srgb", label: "sRGB"), MuiSegmentedOption(value: "p3", label: "P3")],
                    format: $format, quality: $quality, colorSpace: $colorSpace,
                    dismissed: { open = false }
                )
            }
            .frame(width: 400, height: 300)
        }
    }
    return Demo()
}
