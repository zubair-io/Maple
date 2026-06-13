// PanoMergeView.swift — Panorama merge view with options, progress, and results.
//
// Presented when the user taps "Merge to panorama…" from the multi-select
// action bar.  Driven by `PanoMergeSession` (MapleCore). Runs against
// `MockPanoStitcher` until the real FFI impl lands (M4, #1234).
//
// Mac/iPad and iPhone: presented as a modal sheet via `.sheet(isPresented:)`
// in AppShell. Cancel/Done dismisses the sheet and returns to browse.
//
// Ticket: #1236 / Part of #1234

import SwiftUI
import MapleCore

// MARK: - PanoMergeView

struct PanoMergeView: View {
    let assets: [AssetRef]
    let session: PanoMergeSession
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                inputFramesSection
                optionsSection

                switch session.state {
                case .idle:
                    EmptyView()
                case .running(let stage, _, let overall):
                    progressSection(stage: stage, overall: overall)
                case .done(let result):
                    resultSection(result: result)
                case .error(let stitchError):
                    errorSection(stitchError: stitchError)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Merge Panorama")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        session.cancel()
                        onDismiss()
                    }
                    .accessibilityLabel("Cancel panorama merge and return to browse")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if session.isRunning {
                        Button("Stop") {
                            session.cancel()
                        }
                        .accessibilityLabel("Stop the in-progress stitch")
                    } else if case .done = session.state {
                        Button("Done") { onDismiss() }
                            .accessibilityLabel("Close panorama results and return to browse")
                    } else {
                        Button("Merge") {
                            session.start(assets: assets)
                        }
                        .disabled(assets.count < 2)
                        .accessibilityLabel("Start panorama merge with \(assets.count) selected frames")
                    }
                }
            }
        }
    }

    // MARK: - Sections

    private var inputFramesSection: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(assets) { asset in
                        VStack(spacing: 4) {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color.secondary.opacity(0.2))
                                .frame(width: 64, height: 48)
                                .overlay(
                                    Image(systemName: "photo")
                                        .foregroundStyle(.secondary)
                                )
                            Text(asset.displayName)
                                .font(.caption2)
                                .lineLimit(1)
                                .frame(width: 64)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Input frame: \(asset.displayName)")
                    }
                }
                .padding(.vertical, 8)
            }
        } header: {
            Text("\(assets.count) Frames Selected")
        }
    }

    private var optionsSection: some View {
        Section {
            // Retention picker
            Picker("Retention", selection: Binding(
                get: { session.options.retention },
                set: { session.options.retention = $0 }
            )) {
                ForEach(PanoOptions.Retention.allCases, id: \.self) { r in
                    Text(r.displayName).tag(r)
                }
            }
            .disabled(session.isRunning)
            .accessibilityLabel("Retention mode")

            Text(session.options.retention.helpText)
                .font(.caption)
                .foregroundStyle(.secondary)

            // Local alignment picker
            Picker("Local Alignment", selection: Binding(
                get: { session.options.localAlign },
                set: { session.options.localAlign = $0 }
            )) {
                ForEach(PanoOptions.LocalAlign.allCases, id: \.self) { a in
                    Text(a.displayName).tag(a)
                }
            }
            .disabled(session.isRunning)
            .accessibilityLabel("Local mesh alignment mode")

            Text(session.options.localAlign.helpText)
                .font(.caption)
                .foregroundStyle(.secondary)

            // Strategy picker
            Picker("Geometry", selection: Binding(
                get: { session.options.strategy },
                set: { session.options.strategy = $0 }
            )) {
                ForEach(PanoOptions.Strategy.allCases, id: \.self) { s in
                    Text(s.displayName).tag(s)
                }
            }
            .disabled(session.isRunning)
            .accessibilityLabel("Panorama geometry strategy")

            Text(session.options.strategy.helpText)
                .font(.caption)
                .foregroundStyle(.secondary)

        } header: {
            Text("Options")
        }
    }

    @ViewBuilder
    private func progressSection(stage: PanoStage, overall: Double) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(stage.displayName)
                        .font(.subheadline)
                    Spacer()
                    Text(Int(overall * 100).description + "%")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                ProgressView(value: overall)
                    .progressViewStyle(.linear)
                    .accessibilityLabel("Overall panorama merge progress: \(Int(overall * 100)) percent")
            }
            .padding(.vertical, 4)
        } header: {
            Text("Progress")
        }
    }

    @ViewBuilder
    private func resultSection(result: PanoResult) -> some View {
        Section {
            HStack {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .imageScale(.large)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Panorama complete")
                        .font(.subheadline.weight(.medium))
                    Text(result.outputURL.lastPathComponent)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)

            Text(result.reportSummary)
                .font(.caption)
                .foregroundStyle(.secondary)

            // M5: wire "Add to Library" here — the real stitcher (M4) will
            // return an outputURL pointing at the final DNG/TIFF; M5 will
            // hand it to the Library source adapter and select it in the grid.
            // "Show in Finder" is macOS-only: there is no Finder on iOS, so
            // the control is hidden entirely on that platform rather than
            // shown as a permanently-disabled dead button.
            #if os(macOS)
            Button("Show in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([result.outputURL])
            }
            .accessibilityLabel("Reveal panorama output in Finder")
            #endif
        } header: {
            Text("Result")
        }
    }

    @ViewBuilder
    private func errorSection(stitchError: PanoMergeSession.StitchError) -> some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .imageScale(.large)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Merge failed")
                        .font(.subheadline.weight(.medium))
                    Text(stitchError.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)

            Button("Try Again") {
                session.reset()
                session.start(assets: assets)
            }
            .accessibilityLabel("Retry the panorama merge with the same settings")
        } header: {
            Text("Error")
        }
    }
}

// MARK: - Option display name + help text extensions

extension PanoOptions.Retention {
    var displayName: String {
        switch self {
        case .keep:   return "Keep (recommended)"
        case .strict: return "Strict"
        }
    }
    var helpText: String {
        switch self {
        case .keep:   return "Include frames even when overlap quality is marginal. Best for wide sequences."
        case .strict: return "Exclude frames below the overlap quality threshold. Cleaner seams on dense sequences."
        }
    }
}

extension PanoOptions.LocalAlign {
    var displayName: String {
        switch self {
        case .mesh: return "Mesh warp (recommended)"
        case .off:  return "Off"
        }
    }
    var helpText: String {
        switch self {
        case .mesh: return "Corrects residual lens-roll and perspective drift after global solving."
        case .off:  return "Skip the mesh pass. Faster; suitable when lens distortion is negligible."
        }
    }
}

extension PanoOptions.Strategy {
    var displayName: String {
        switch self {
        case .auto:     return "Auto (recommended)"
        case .rotation: return "Rotation"
        case .tile:     return "Flat tile"
        }
    }
    var helpText: String {
        switch self {
        case .auto:     return "Solver picks the best geometry model based on the feature graph topology."
        case .rotation: return "Pure rotation from a fixed pivot. Best for handheld panoramic pans."
        case .tile:     return "Flat-plane tiling. Best for copy-stand or flat-art sequences."
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Idle") {
    PanoMergeView(
        assets: (0..<6).map { AssetRef.preview(displayName: "IMG_\($0).dng") },
        session: PanoMergeSession(stitcher: MockPanoStitcher()),
        onDismiss: {}
    )
}
#endif
