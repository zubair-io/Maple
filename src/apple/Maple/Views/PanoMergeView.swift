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
// Merge never downloads anything (#4554): the stitcher uses the classical
// matcher unless Settings → Pano opted into the ML matcher and it is
// installed. An opted-in ML matcher that is missing or fails to load runs
// classical instead (#5487); PanoMatcherNote says so under the preview and
// the result and offers Settings → Pano via `onOpenPanoSettings` (AppShell
// dismisses this sheet and opens that tab).
//
// Quick preview (#4579): opening the sheet with two or more frames starts a
// low-resolution preview (PanoPreviewSection); option changes re-run it. The
// preview's solved alignment stays in the session, and "Create Panorama"
// hands it to the full stitch so matching is not repeated.
//
// Output size (#5454): on iPhone and iPad, PanoOutputSizeSection offers a
// smaller output when the preview says full resolution would not fit.
//
// Run on server (#5488): frames that all live on one Maple server can stitch
// there instead (ServerPanoStitcher). Frames with no file on this device can
// only stitch there, so the sheet starts on the server and says so; frames
// that could go either way get a "Run On" picker. The job runs on the server
// whatever the app does, so a lost connection is a Try Again away.
//
// Ticket: #1236 / Part of #1234 / #1241 / #4554 / #4579 / #5454 / #5486 / #5488

import MapleCore
import MapleUI
import SwiftUI

#if os(macOS)
  import AppKit
#endif

// MARK: - PanoMergeView

struct PanoMergeView: View {
  let assets: [AssetRef]
  /// URL-less frames (Maple Cloud, PhotoKit) load their thumbnails through it.
  let source: (any ImageSource)?
  let session: PanoMergeSession
  /// Where a merge runs: on this device, or on the frames' Maple server
  /// (`nil` when they are not all on one).
  let deviceStitcher: any PanoStitching
  let serverStitcher: ServerPanoStitcher?
  let onDismiss: () -> Void
  /// Called when the user taps Done after a successful stitch. The library
  /// caller (AppShell) uses this to inject the result into BrowseViewModel
  /// (M5 of #1234) before dismissing the sheet.
  var onComplete: ((PanoResult) -> Void)? = nil
  /// Called from PanoMatcherNote's "Set Up in Settings → Pano". AppShell
  /// dismisses this sheet and opens Settings on the Pano tab. (#1241, #5487)
  var onOpenPanoSettings: (() -> Void)? = nil

  @State private var thumbnails = ThumbnailProvider.local()
  /// Why the frames' server can't stitch; `nil` when it can or is unchecked.
  @State private var serverUnavailable: String?

  var body: some View {
    NavigationStack {
      Form {
        inputFramesSection
        runOnSection
        PanoPreviewSection(
          session: session,
          onRetry: { session.preview(assets: assets) },
          onOpenPanoSettings: onOpenPanoSettings
        )
        optionsSection
        PanoOutputSizeSection(session: session)

        switch session.state {
        case .idle:
          EmptyView()
        case .finishingAlignment:
          progressSection(title: "Finishing alignment…", overall: previewFraction)
        case .running(let stage, _, let overall):
          progressSection(
            title: runsOnServer && overall == 0 ? "Waiting for the server…" : stage.displayName,
            overall: overall)
        case .done(let result):
          resultSection(result: result)
        case .error(let stitchError):
          errorSection(stitchError: stitchError)
        }
      }
      .formStyle(.grouped)
      .task {
        if let serverStitcher, let reason = await serverStitcher.unavailableReason() {
          serverUnavailable = reason
          if canRunOnDevice { session.use(deviceStitcher) }
        }
        session.preview(assets: assets)
      }
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
          } else if case .done(let result) = session.state {
            Button("Done") {
              // M5: inject the result into the library before dismissing.
              onComplete?(result)
              onDismiss()
            }
            .accessibilityLabel("Add panorama to library and return to browse")
          } else {
            Button("Create Panorama") {
              session.start(assets: assets)
            }
            .disabled(assets.count < 2)
            .accessibilityLabel(
              session.alignment == nil
                ? "Create the full panorama from \(assets.count) selected frames"
                : "Create the full panorama from \(assets.count) selected frames, reusing the preview's alignment"
            )
          }
        }
      }
    }
  }

  // MARK: - Run on (#5488)

  private var runsOnServer: Bool {
    guard let serverStitcher else { return false }
    return session.stitcher === serverStitcher
  }

  /// Every frame has a file this device can read.
  private var canRunOnDevice: Bool { assets.allSatisfy { $0.primaryURL != nil } }

  @ViewBuilder
  private var runOnSection: some View {
    if let serverStitcher {
      Section {
        if canRunOnDevice {
          Picker(
            "Run On",
            selection: Binding(
              get: { runsOnServer },
              set: { session.use($0 ? serverStitcher : deviceStitcher) }
            )
          ) {
            Text("This Device").tag(false)
            Text("Server").tag(true)
          }
          .disabled(session.isRunning || serverUnavailable != nil)
          .accessibilityLabel("Where the panorama is stitched")
        } else {
          HStack(spacing: 8) {
            MuiIcon(name: "dns", size: .sm)
              .accessibilityHidden(true)
            Text("Runs on your Maple server")
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("pano-runs-on-server")
        }
        if let serverUnavailable {
          Text(serverUnavailable)
            .font(.caption)
            .foregroundStyle(.secondary)
        } else if runsOnServer {
          Text(
            "The server stitches the frames where they are stored and adds the panorama to a Panoramas folder beside them. It keeps going if you leave the app."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }
      } header: {
        Text("Stitching")
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
              PhotoThumbnailCell(
                item: PhotoGridItem(local: asset, source: source, overlays: GridCellOverlays()),
                provider: thumbnails,
                displayMode: .fill
              )
              .frame(width: 64, height: 64)
              Text(asset.displayName)
                .font(.caption2)
                .lineLimit(1)
                .frame(width: 64)
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("pano-frame-\(asset.displayName)")
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
      Picker(
        "Retention",
        selection: Binding(
          get: { session.options.retention },
          set: { session.options.retention = $0 }
        )
      ) {
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
      Picker(
        "Local Alignment",
        selection: Binding(
          get: { session.options.localAlign },
          set: { session.options.localAlign = $0 }
        )
      ) {
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
      Picker(
        "Geometry",
        selection: Binding(
          get: { session.options.strategy },
          set: { session.options.strategy = $0 }
        )
      ) {
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

  /// Progress of the preview a pending Create Panorama is waiting on.
  private var previewFraction: Double {
    if case .running(_, let overall) = session.previewState { return overall }
    return 1
  }

  @ViewBuilder
  private func progressSection(title: String, overall: Double) -> some View {
    Section {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(title)
            .font(.subheadline)
          Spacer()
          Text(Int(overall * 100).description + "%")
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
        ProgressView(value: overall)
          .progressViewStyle(.linear)
          .accessibilityLabel(
            "\(title), overall panorama merge progress: \(Int(overall * 100)) percent")
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
        MuiIcon(name: "check_circle", size: .sm, filled: true)
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

      PanoMatcherNote(matcher: result.matcher, onOpenPanoSettings: onOpenPanoSettings)

      // M5 (complete): tapping Done (toolbar) calls onComplete which
      // hands outputURL to BrowseViewModel.injectPanoResult — the
      // panorama appears in the library grid and is auto-selected.
      // "Show in Finder" is macOS-only: there is no Finder on iOS.
      #if os(macOS)
        if result.serverAssetID == nil {
          Button("Show in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting([result.outputURL])
          }
          .accessibilityLabel("Reveal panorama output in Finder")
        }
      #endif
    } header: {
      Text("Result")
    }
  }

  @ViewBuilder
  private func errorSection(stitchError: PanoMergeSession.StitchError) -> some View {
    Section {
      HStack(alignment: .top, spacing: 10) {
        MuiIcon(name: "warning", size: .sm, filled: true)
          .foregroundStyle(.red)
          .imageScale(.large)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 4) {
          Text("Merge failed")
            .font(.subheadline.weight(.medium))
            .accessibilityLabel("Panorama merge failed")
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
    case .keep: return "Keep (recommended)"
    case .strict: return "Strict"
    }
  }
  var helpText: String {
    switch self {
    case .keep:
      return "Include frames even when overlap quality is marginal. Best for wide sequences."
    case .strict:
      return "Exclude frames below the overlap quality threshold. Cleaner seams on dense sequences."
    }
  }
}

extension PanoOptions.LocalAlign {
  var displayName: String {
    switch self {
    case .mesh: return "Mesh warp (recommended)"
    case .off: return "Off"
    }
  }
  var helpText: String {
    switch self {
    case .mesh: return "Corrects residual lens-roll and perspective drift after global solving."
    case .off: return "Skip the mesh pass. Faster; suitable when lens distortion is negligible."
    }
  }
}

extension PanoOptions.Strategy {
  var displayName: String {
    switch self {
    case .auto: return "Auto (recommended)"
    case .rotation: return "Rotation"
    case .tile: return "Flat tile"
    }
  }
  var helpText: String {
    switch self {
    case .auto: return "Solver picks the best geometry model based on the feature graph topology."
    case .rotation: return "Pure rotation from a fixed pivot. Best for handheld panoramic pans."
    case .tile: return "Flat-plane tiling. Best for copy-stand or flat-art sequences."
    }
  }
}

// MARK: - Preview

#if DEBUG
  #Preview("Idle") {
    PanoMergeView(
      assets: (0..<6).map { AssetRef.preview(displayName: "IMG_\($0).dng") },
      source: nil,
      session: PanoMergeSession(stitcher: MockPanoStitcher()),
      deviceStitcher: MockPanoStitcher(),
      serverStitcher: nil,
      onDismiss: {}
    )
  }
#endif
