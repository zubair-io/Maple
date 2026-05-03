// JoinWithInviteView.swift
import SwiftUI
import MapleCore
import AuthenticationServices
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct JoinWithInviteView: View {
  @Environment(AuthSession.self) private var session
  @State private var serverString = ""
  @State private var email = ""
  @State private var code = ""
  @State private var working = false
  @State private var errorText: String? = nil

  var body: some View {
    Form {
      Section("Server") {
        TextField("https://maple.example", text: $serverString)
          #if !os(macOS)
          .textInputAutocapitalization(.never)
          #endif
      }
      Section("Account") {
        TextField("Email", text: $email)
        TextField("Invite code", text: $code).textCase(.uppercase)
      }
      if let errorText { Text(errorText).foregroundStyle(.red).font(.caption) }
      Button {
        Task { await join() }
      } label: { Label("Create passkey", systemImage: "key.fill") }
        .disabled(serverString.isEmpty || email.isEmpty || code.count != 8 || working)
    }
    .navigationTitle("Join Maple Server")
  }

  @MainActor func join() async {
    working = true; defer { working = false }
    guard let server = URL(string: serverString) else { errorText = "bad URL"; return }
    let client = AuthClient(server: server)
    do {
      let resp = try await client.register(
        email: email, inviteCode: code,
        deviceLabel: deviceLabel(), presentationAnchor: anchor()
      )
      // Caller navigation: append this server to SourceSelection + persist tokens.
      let local = AuthSession(server: server, client: client)
      try local.setSignedIn(
        user: resp.user,
        tokens: AuthTokens(access: resp.access_token, refresh: resp.refresh_token)
      )
    } catch { errorText = error.localizedDescription }
  }
}

@MainActor private func anchor() -> ASPresentationAnchor {
  #if os(macOS)
  return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
  #else
  return UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
  #endif
}

private func deviceLabel() -> String {
  #if os(macOS)
  return Host.current().localizedName ?? "Mac"
  #else
  return UIDevice.current.name
  #endif
}
