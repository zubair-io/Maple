// src/apple/Maple TV/PairingScreen.swift
import SwiftUI

/// The pairing landing screen: a QR code plus the identical string
/// rendered as a monospaced manual code (for a camera-less path, and for
/// UI-test/E2E automation that reads the code through the accessibility
/// tree rather than photographing the screen).
struct PairingScreen: View {
  @State private var viewModel: PairingViewModel

  init(onPaired: @escaping () -> Void) {
    _viewModel = State(initialValue: PairingViewModel(onPaired: onPaired))
  }

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      content
    }
    .task { viewModel.start() }
    .onDisappear { viewModel.stop() }
  }

  @ViewBuilder
  private var content: some View {
    switch viewModel.phase {
    case .idle:
      ProgressView("Preparing pairing code…")
        .tint(MapleTVTheme.textPrimary)
        .foregroundStyle(MapleTVTheme.textPrimary)
        .accessibilityLabel("Preparing pairing code")
    case .ready(let qrString, let expiresAt):
      readyView(code: qrString, expiresAt: expiresAt)
    case .failed(let message):
      failedView(message: message)
    }
  }

  private func readyView(code: String, expiresAt: Date) -> some View {
    HStack(alignment: .center, spacing: 72) {
      VStack(alignment: .leading, spacing: 20) {
        Text("Pair Maple TV")
          .font(.system(size: 48, weight: .semibold))
          .foregroundStyle(MapleTVTheme.textPrimary)
        Text("Open Maple on your iPhone or iPad, then scan this code or enter it manually to connect this Apple TV.")
          .font(.system(size: 24))
          .foregroundStyle(MapleTVTheme.textMuted)
          .frame(maxWidth: 520, alignment: .leading)
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text(Self.countdownText(until: expiresAt, now: context.date))
            .font(.system(size: 20, weight: .medium, design: .monospaced))
            .foregroundStyle(MapleTVTheme.textMuted)
        }
        Button("Generate new code") { viewModel.start() }
          .accessibilityLabel("Generate a new pairing code")
      }

      VStack(spacing: 20) {
        QRCodeView(string: code)
          .frame(width: 300, height: 300)
          .padding(24)
          .background(Color.white)
          .clipShape(RoundedRectangle(cornerRadius: 20))
          .accessibilityLabel("Pairing code")
          .accessibilityValue(code)

        Text(code)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(MapleTVTheme.textMuted)
          .lineLimit(3)
          .truncationMode(.middle)
          .frame(maxWidth: 340)
          .accessibilityIdentifier("pairing-manual-code")
          .accessibilityLabel("Manual pairing code")
          .accessibilityValue(code)
      }
      .padding(32)
      .background(MapleTVTheme.surface)
      .clipShape(RoundedRectangle(cornerRadius: 28))
      .overlay(
        RoundedRectangle(cornerRadius: 28)
          .stroke(MapleTVTheme.border, lineWidth: 1)
      )
    }
    .padding(72)
  }

  private func failedView(message: String) -> some View {
    VStack(spacing: 24) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 64))
        .foregroundStyle(MapleTVTheme.primary)
        .accessibilityHidden(true)
      Text("Couldn't start pairing")
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text(message)
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
      Button("Retry") { viewModel.start() }
        .accessibilityLabel("Retry pairing")
    }
    .padding(72)
  }

  private static func countdownText(until expiresAt: Date, now: Date) -> String {
    let remaining = max(0, Int(expiresAt.timeIntervalSince(now)))
    let minutes = remaining / 60
    let seconds = remaining % 60
    return String(format: "Code refreshes in %d:%02d", minutes, seconds)
  }
}
