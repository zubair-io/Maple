// ManageUsersView.swift
//
// Plan 2026-04-28-passkey-auth Task B10 extends this view to emit a QR
// alongside a freshly-minted invite code so the recipient can scan it from
// `QRScannerView` (or any other QR reader) and land in
// `AddMapleCloudSheet` pre-filled.

import SwiftUI
import MapleCore
import CoreImage
import CoreImage.CIFilterBuiltins
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ManageUsersView: View {
  @Environment(AuthSession.self) private var session
  @State private var inviteEmail = ""
  @State private var newCode: String? = nil
  @State private var newCodeEmail: String? = nil
  @State private var pending: [(code: String, email: String, expiresAt: String, consumedAt: String?)] = []
  let client: AuthClient

  var body: some View {
    Form {
      Section("Invite a user") {
        TextField("Email", text: $inviteEmail)
        Button("Generate invite code") { Task { await invite() } }
          .disabled(inviteEmail.isEmpty)
        if let code = newCode, let email = newCodeEmail {
          VStack(alignment: .leading, spacing: 8) {
            Text("Share: **\(code)**").textSelection(.enabled)
            inviteQRImage(code: code, email: email)
              .accessibilityLabel("Invite QR for \(email)")
          }
        }
      }
      Section("Pending invites") {
        ForEach(pending, id: \.code) { p in
          HStack {
            VStack(alignment: .leading) { Text(p.email); Text(p.code).font(.caption.monospaced()) }
            Spacer()
            Button("Rescind", role: .destructive) { Task { await rescind(p.code) } }
          }
        }
      }
    }
    .task { await reload() }
  }

  func invite() async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    let r = try? await client.createInvite(email: inviteEmail, accessToken: access)
    newCode = r?.code
    newCodeEmail = r?.code != nil ? inviteEmail : nil
    await reload()
  }
  func rescind(_ code: String) async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    try? await client.rescindInvite(code: code, accessToken: access); await reload()
  }
  func reload() async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    let raw = (try? await client.listInvites(accessToken: access)) ?? []
    pending = raw.compactMap {
      guard let code = $0["code"] as? String, let email = $0["email"] as? String,
            let exp = $0["expires_at"] as? String else { return nil }
      return (code, email, exp, $0["consumed_at"] as? String)
    }
  }

  /// Renders the QR for a `maple://join?…` payload built from the current
  /// server + the freshly-issued code/email. Falls back to an empty view if
  /// CoreImage can't produce an image (extremely defensive — the QR
  /// generator is a system filter and in practice always succeeds).
  @ViewBuilder
  @MainActor
  private func inviteQRImage(code: String, email: String) -> some View {
    let payload = buildInvitePayload(server: client.server, code: code, email: email)
    #if os(macOS)
    if let img = makeQRImageMac(payload) {
      Image(nsImage: img)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .frame(width: 180, height: 180)
    }
    #else
    if let img = makeQRImageUI(payload) {
      Image(uiImage: img)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .frame(width: 180, height: 180)
    }
    #endif
  }
}

// MARK: - QR generation

#if os(macOS)
@MainActor
private func makeQRImageMac(_ payload: String) -> NSImage? {
  let f = CIFilter.qrCodeGenerator()
  f.message = Data(payload.utf8)
  f.correctionLevel = "M"
  guard let img = f.outputImage?.transformed(by: .init(scaleX: 6, y: 6)) else { return nil }
  let rep = NSCIImageRep(ciImage: img)
  let nsi = NSImage(size: rep.size)
  nsi.addRepresentation(rep)
  return nsi
}
#else
@MainActor
private func makeQRImageUI(_ payload: String) -> UIImage? {
  let f = CIFilter.qrCodeGenerator()
  f.message = Data(payload.utf8)
  f.correctionLevel = "M"
  guard let ci = f.outputImage?.transformed(by: .init(scaleX: 6, y: 6)) else { return nil }
  let context = CIContext()
  guard let cg = context.createCGImage(ci, from: ci.extent) else { return nil }
  return UIImage(cgImage: cg)
}
#endif

// MARK: - Previews
//
// Issue #139 — invite admin panel against the preview AuthSession. The
// `.task` modifier fires `client.listInvites` against the unreachable
// preview server and leaves the Pending Invites section empty.

#Preview("Owner") {
    ManageUsersView(client: AuthClient.preview())
        .environment(AuthSession.preview(state: .signedInOwner))
}

#Preview("Member") {
    ManageUsersView(client: AuthClient.preview())
        .environment(AuthSession.preview(state: .signedInMember))
}
