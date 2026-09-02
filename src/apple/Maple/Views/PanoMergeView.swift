// PanoMergeView.swift — Panorama merge view with options, progress, and results.
//
// Presented when the user taps "Merge to panorama…" from the multi-select
// action bar.  Driven by `PanoMergeSession` (MapleCore). Wired to
// `RustPanoStitcher` (M4, #1234) via AppShell; the real stitch runs and
// the output PNG is imported into the library (M5) when the user taps Done.
//
// Mac/iPad and iPhone: presented as a modal sheet via `.sheet(isPresented:)`
// in AppShell. Cancel/Done dismisses the sheet and returns to browse.
//
// Not-provisioned UX (#1241): when the error state is `modelsNotInstalled`
// the error section shows a "Configure in Settings → Pano" button that calls
// the `onOpenPanoSettings` callback (supplied by AppShell). AppShell then
// dismisses this sheet, opens the Settings sheet, and navigates to the Pano tab.
//
// Ticket: #1236 / Part of #1234 / #1241

import SwiftUI
import MapleCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - PanoMergeView

struct PanoMergeView: View {
    let assets: [AssetRef]
    let session: PanoMergeSession
    let onDismiss: () -> Void
    /// Called when the user taps Done after a successful stitch. The library
    /// caller (AppShell) uses this to inject the result into BrowseViewModel
    /// (M5 of #1234) before dismissing the sheet.
    var onComplete: ((PanoResult) -> Void)? = nil
    /// Called when the user taps "Configure in Settings → Pano" after a
    /// `modelsNotInstalled` error. AppShell dismisses this sheet and opens
    /// Settings navigated to the Pano tab. (#1241)
    var onOpenPanoSettings: (() -> Void)? = nil

    /// Shared thumbnail loader for the input-frame previews. `@State` keeps the
    /// actor (and its in-memory cache) stable across body re-evaluations.
    @State private var thumbLoader = ThumbnailLoader()

    /// Drives the auto-download-on-Merge flow (#1234 M6): if the ML runtime
    /// isn't provisioned when the user taps Merge, fetch it inline (with
    /// progress) and then start the stitch — no detour through Settings.
    @State private var provisionModel = PanoProvisionModel()

    var body: some View {
        NavigationStack {
            Form {
                inputFramesSection
                optionsSection

                provisionStatusSection

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
                    if provisionModel.isBusy {
                        Button("Installing…") {}
                            .disabled(true)
                            .accessibilityLabel("Downloading panorama components")
                    } else if session.isRunning {
                        Button("Stop") {
                            session.cancel()
                        }
                        .accessibilityLabel("Stop the in-progress stitch")
                    } else if case .done(let result) = session.state {
                        Button("Done") {
                            // M5: inject the result into the library before dismissing.
                            onComplete?(result)
                            onDismiss()
                        }
                        .accessibilityLabel("Add panorama to library and return to browse")
                    } else {
                        Button("Merge") {
                            startMerge()
                        }
                        .disabled(assets.count < 2)
                        .accessibilityLabel("Start panorama merge with \(assets.count) selected frames")
                    }
                }
            }
        }
    }

    // MARK: - Merge flow (auto-provision, then stitch)

    private func startMerge() {
        let status = PanoProvisioning().status()
        // Ready, or a manual Settings/env override is in force (auto-download
        // into the app-support default wouldn't change resolution) → start
        // directly. An unprovisioned override surfaces the existing
        // modelsNotInstalled error with the "Configure in Settings" path.
        if PanoProvisioner.isReady(status) || !PanoProvisioner.canAutoProvision(status) {
            session.start(assets: assets)
            return
        }
        // Not provisioned and we can auto-provision: download inline, then stitch.
        Task {
            await provisionModel.download {
                session.start(assets: assets)
            }
        }
    }

    @ViewBuilder
    private var provisionStatusSection: some View {
        switch provisionModel.state {
        case .idle:
            EmptyView()
        case let .running(fraction, label):
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(label).font(.subheadline)
                        Spacer()
                        Text("\(Int((fraction * 100).rounded()))%")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    ProgressView(value: fraction).progressViewStyle(.linear)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Downloading panorama components, \(Int((fraction * 100).rounded())) percent")
            } header: {
                Text("Setting Up")
            }
        case let .failed(message):
            Section {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .imageScale(.large)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Download failed")
                            .font(.subheadline.weight(.medium))
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                Button("Retry Download") { startMerge() }
                    .accessibilityLabel("Retry downloading panorama components")
            } header: {
                Text("Setting Up")
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
                            PanoFrameThumbnail(asset: asset, loader: thumbLoader)
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

            // M5 (complete): tapping Done (toolbar) calls onComplete which
            // hands outputURL to BrowseViewModel.injectPanoResult — the
            // panorama appears in the library grid and is auto-selected.
            // "Show in Finder" is macOS-only: there is no Finder on iOS.
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
                    Text(stitchError.isModelsNotInstalled ? "Models not installed" : "Merge failed")
                        .font(.subheadline.weight(.medium))
                        .accessibilityLabel(stitchError.isModelsNotInstalled
                            ? "Panorama models not installed"
                            : "Panorama merge failed")
                    Text(stitchError.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)

            if stitchError.isModelsNotInstalled {
                // Not-provisioned path: direct the user to Settings → Pano
                // so they can configure the models directory and ORT dylib path.
                // The "Configure" button calls onOpenPanoSettings (supplied by
                // AppShell) which dismisses this sheet and opens the Pano settings
                // tab. If the callback isn't wired (e.g. previews), we fall back
                // to the plain retry button so the view is never broken.
                if let openSettings = onOpenPanoSettings {
                    Button("Configure in Settings → Pano") {
                        openSettings()
                    }
                    .accessibilityLabel("Open Settings → Pano to configure panorama model and runtime paths")
                } else {
                    Text("Open Settings → Pano to configure the models directory and ONNX Runtime path.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Navigate to Settings then Pano to configure panorama models")
                }
            } else {
                Button("Try Again") {
                    session.reset()
                    session.start(assets: assets)
                }
                .accessibilityLabel("Retry the panorama merge with the same settings")
            }
        } header: {
            Text("Error")
        }
    }
}

// MARK: - Input-frame thumbnail

/// One 64×48 input-frame preview. Loads through the app's `ThumbnailLoader`
/// (disk-cached, security-scoped): a neutral glyph while loading, the real
/// thumbnail when decoded, and a clean "can't preview" glyph if the frame
/// can't be decoded — never raw bytes.
private struct PanoFrameThumbnail: View {
    let asset: AssetRef
    let loader: ThumbnailLoader

    @State private var image: Image?
    @State private var failed = false

    var body: some View {
        RoundedRectangle(cornerRadius: MapleTokens.Radius.sm)
            .fill(Color.secondary.opacity(0.2))
            .frame(width: 64, height: 48)
            .overlay {
                if let image {
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: failed ? "exclamationmark.triangle" : "photo")
                        .foregroundStyle(.secondary)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
            .task(id: asset.id) { await load() }
    }

    private func load() async {
        // Reset up front so a reused cell (asset.id changed) doesn't show the
        // previous frame's thumbnail or failure state during the new load.
        image = nil
        failed = false
        guard let url = asset.primaryURL else { failed = true; return }
        let data = await loader.load(for: url, scopeParentURL: asset.scopeParentURL)
        if Task.isCancelled { return }
        if let data, let img = Self.image(from: data) {
            image = img
        } else {
            failed = true
        }
    }

    private static func image(from data: Data) -> Image? {
        #if os(macOS)
        return NSImage(data: data).map(Image.init(nsImage:))
        #else
        return UIImage(data: data).map(Image.init(uiImage:))
        #endif
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
