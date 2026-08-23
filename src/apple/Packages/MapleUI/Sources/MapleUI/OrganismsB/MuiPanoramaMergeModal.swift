// MuiPanoramaMergeModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Stitch options and progress, built on
// Overlay Shell from Segmented Toggle (projection + blend mode), Progress,
// and Media Cell (repeated source-frame thumbnails). Projection/blend-mode
// option sets are fixed — intrinsic to what the stitcher supports, not
// host data.

import SwiftUI

public struct MuiPanoramaFrame: Identifiable, Sendable {
    public let id: String
    public let url: URL?
    public let alt: String

    public init(id: String, url: URL?, alt: String) {
        self.id = id
        self.url = url
        self.alt = alt
    }
}

public struct MuiPanoramaMergeSettings: Sendable {
    public let projection: String
    public let blendMode: String
}

public struct MuiPanoramaMergeModal: View {
    public static let projectionOptions: [MuiSegmentedOption] = [
        MuiSegmentedOption(value: "spherical", label: "Spherical"),
        MuiSegmentedOption(value: "cylindrical", label: "Cylindrical"),
        MuiSegmentedOption(value: "perspective", label: "Perspective"),
    ]
    public static let blendModeOptions: [MuiSegmentedOption] = [
        MuiSegmentedOption(value: "linear", label: "Linear"),
        MuiSegmentedOption(value: "multi-band", label: "Multi-band"),
    ]

    public let isPresented: Bool
    public let contained: Bool
    public let frames: [MuiPanoramaFrame]
    @Binding public var projection: String
    @Binding public var blendMode: String
    public let stitching: Bool
    public let progress: Double
    public let mergeRequested: ((MuiPanoramaMergeSettings) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        frames: [MuiPanoramaFrame],
        projection: Binding<String>,
        blendMode: Binding<String>,
        stitching: Bool = false,
        progress: Double = 0,
        mergeRequested: ((MuiPanoramaMergeSettings) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.frames = frames
        self._projection = projection
        self._blendMode = blendMode
        self.stitching = stitching
        self.progress = progress
        self.mergeRequested = mergeRequested
        self.dismissed = dismissed
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Panorama Merge", contained: contained) {
            MuiText("Panorama Merge", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: MuiTokens.spacingXs) {
                        ForEach(frames) { frame in
                            MuiMediaCell(url: frame.url, alt: frame.alt, filename: .constant(frame.alt), size: .sm)
                        }
                    }
                }
                labeledSegment("Projection", options: Self.projectionOptions, value: $projection)
                labeledSegment("Blend mode", options: Self.blendModeOptions, value: $blendMode)
                if stitching {
                    MuiProgress(shape: .bar, value: progress, label: "\(Int(progress))%")
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Merge", variant: .primary, isLoading: stitching, disabled: stitching) {
                    mergeRequested?(MuiPanoramaMergeSettings(projection: projection, blendMode: blendMode))
                }
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
}

#Preview("MuiPanoramaMergeModal") {
    struct Demo: View {
        @State private var open = false
        @State private var projection = "spherical"
        @State private var blendMode = "linear"
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Panorama Merge", variant: .primary) { open = true }
                MuiPanoramaMergeModal(
                    isPresented: open,
                    frames: (1...4).map { MuiPanoramaFrame(id: "\($0)", url: nil, alt: "Frame \($0)") },
                    projection: $projection, blendMode: $blendMode,
                    dismissed: { open = false }
                )
            }
            .frame(width: 420, height: 340)
        }
    }
    return Demo()
}
