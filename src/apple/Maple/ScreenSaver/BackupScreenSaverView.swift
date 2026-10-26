// BackupScreenSaverView.swift — the Light Table, shown as a screen saver on
// a plugged-in iPhone or iPad while a Photos backup uploads (#5457). Prints
// come from the library the backup is uploading into; a small badge keeps
// the backup's progress in view. Any touch dismisses it (handled by the
// presenting window, see `BackupScreenSaverController`).

#if os(iOS)
  import MapleCore
  import MapleUI
  import SwiftUI

  /// The Light Table's data for one presentation: the backup's own server
  /// and library, read with the backup's authenticated client.
  @MainActor
  final class BackupScreenSaverSource {
    let viewModel: LightTableViewModel
    let thumbs: LightTableThumbLoader

    init?(settings: BackupSettings) {
      guard settings.isConfigured, let server = URL(string: settings.serverURL) else { return nil }
      let httpClient = makeBackupHTTPClient(server: server)
      let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: server)
      viewModel = LightTableViewModel(
        libraryID: settings.libraryId,
        searchClient: CloudSearchClient(server: effectiveServer, httpClient: httpClient),
        generatedSearchClient: GeneratedSearchClient(
          server: effectiveServer, httpClient: httpClient))
      thumbs = LightTableThumbLoader(
        server: server,
        client: CloudThumbClient(server: effectiveServer, httpClient: httpClient),
        cache: CloudThumbCache())
    }
  }

  struct BackupScreenSaverView: View {
    let source: BackupScreenSaverSource
    let progress: BackupProgressViewModel
    let dismiss: () -> Void

    var body: some View {
      LightTableView(
        viewModel: source.viewModel,
        accent: MuiTokens.primary,
        prefetch: { asset in await source.thumbs.prefetch(asset) },
        printImage: { asset in LightTablePrintPhoto(image: source.thumbs.image(for: asset)) }
      )
      .overlay(alignment: .bottom) {
        BackupScreenSaverBadge(progress: progress)
          .padding(.bottom, MuiTokens.spacingLg)
      }
      .statusBarHidden()
      .persistentSystemOverlays(.hidden)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Light Table screen saver. Backing up, \(progress.progressLabel)")
      .accessibilityHint("Double-tap to return to Maple.")
      .accessibilityAction(.default, dismiss)
      .accessibilityAction(.escape, dismiss)
    }
  }

  /// A small "still backing up" readout on a paper-tinted pill, so it reads
  /// as part of the light table rather than app chrome laid over it.
  private struct BackupScreenSaverBadge: View {
    let progress: BackupProgressViewModel

    var body: some View {
      HStack(spacing: MuiTokens.spacingSm) {
        MuiProgress(shape: .ring, size: .sm, value: progress.fractionDone * 100)
        Text("Backing up · \(progress.progressLabel)")
          .font(MuiTokens.TypeScale.font(.body))
          .foregroundStyle(LightTablePalette.ink.opacity(0.75))
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .padding(.horizontal, MuiTokens.spacingMd)
      .padding(.vertical, MuiTokens.spacingSm)
      .background(.regularMaterial, in: Capsule())
      .environment(\.colorScheme, .light)
      .padding(.horizontal, MuiTokens.spacingMd)
    }
  }
#endif
