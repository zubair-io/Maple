// QRScannerView.swift
//
// Plan 2026-04-28-passkey-auth Task B10.
//
// A minimal QR-payload entry point. Parses the input through
// `parseInviteQR` first and, if that matches, pre-fills `AddMapleCloudSheet`
// via the `onInvite` callback. Anything else is forwarded to `onScan` so
// future QR consumers (legacy pairing URLs, etc.) can plug in alongside.
//
// The Apple app does not currently hold a camera entitlement and we don't
// want to add one solely for this onboarding step, so this view is a paste-
// the-string fallback — sufficient for desktop demos, automation, and for
// users who have the QR open on a second device. A live `AVCaptureSession`
// scanner can drop in later behind the same `onInvite` / `onScan` callbacks
// without touching the parser contract.

import SwiftUI

struct QRScannerView: View {
  /// Fired when the pasted/scanned payload parses as a `maple://join?…`
  /// invite. Callers typically present `AddMapleCloudSheet` pre-filled with
  /// `invite.server` / `invite.email` / `invite.code`.
  var onInvite: (InviteQR) -> Void = { _ in }

  /// Fired for any non-invite payload (e.g. legacy Self-Hosted pairing
  /// URLs). Default is a no-op so callers that only care about invites can
  /// omit it.
  var onScan: (String) -> Void = { _ in }

  /// Optional dismiss hook. The parent presenting this view as a sheet sets
  /// it to flip its `@State` flag back to `false`.
  var onCancel: () -> Void = {}

  @State private var pasted: String = ""
  @State private var errorText: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Scan or paste invite QR")
        .font(.title3.weight(.semibold))
      Text("Paste the contents of a `maple://join?…` link, or the text decoded from an invite QR code.")
        .font(.caption)
        .foregroundStyle(.secondary)

      TextEditor(text: $pasted)
        .frame(minHeight: 80)
        .font(.system(.body, design: .monospaced))
        .accessibilityLabel("Invite payload")

      if let errorText {
        Text(errorText).foregroundStyle(.red).font(.caption)
      }

      HStack {
        Spacer()
        Button("Cancel", action: onCancel)
          .keyboardShortcut(.cancelAction)
        Button("Use payload") { handle() }
          .keyboardShortcut(.defaultAction)
          .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(20)
    .frame(minWidth: 420)
  }

  @MainActor private func handle() {
    let raw = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
    if let invite = parseInviteQR(raw) {
      errorText = nil
      onInvite(invite)
      return
    }
    // Not an invite payload — hand it off to the generic scan callback so
    // legacy QR consumers (e.g. Self-Hosted pairing URLs from commit
    // 2650c95's "QR pairing" path) still get a swing.
    onScan(raw)
    errorText = "That doesn't look like a Maple invite link."
  }
}

// MARK: - Previews
//
// Issue #139 — paste-the-string flow. No external dependencies, so the
// preview is just the default empty editor.

#Preview("Default") {
    QRScannerView()
}
