// SignInView.swift
import SwiftUI
import AuthenticationServices
import MapleCore

struct SignInView: View {
  @Environment(AuthSession.self) private var session
  @State private var email = ""
  @State private var inviteCode = ""
  @State private var claimed: Bool? = nil
  @State private var working = false
  @State private var errorText: String? = nil

  let server: URL
  let client: AuthClient

  var body: some View {
    VStack(spacing: 16) {
      Text(claimed == true ? "Sign in to \(server.host ?? "")" : "Claim \(server.host ?? "")")
        .font(.title2.weight(.semibold))
      TextField("Email", text: $email)
        .textFieldStyle(.roundedBorder)
        .accessibilityLabel("Email")
      if claimed == true {
        Button { Task { await signIn() } } label: { Label("Sign in with passkey", systemImage: "key.fill") }
          .buttonStyle(.borderedProminent).disabled(email.isEmpty || working)
        Button("Have an invite code?") { /* navigate to JoinWithInviteView */ }
          .buttonStyle(.plain)
      } else if claimed == false {
        Button { Task { await claim() } } label: { Label("Claim with passkey", systemImage: "key.fill") }
          .buttonStyle(.borderedProminent).disabled(email.isEmpty || working)
      } else {
        ProgressView()
      }
      if let errorText { Text(errorText).foregroundStyle(.red).font(.caption) }
    }
    .padding(32)
    .task { claimed = (try? await client.bootstrap()) }
  }

  @MainActor func claim() async {
    working = true; defer { working = false }
    do {
      let resp = try await client.register(
        email: email, inviteCode: nil,
        deviceLabel: deviceLabel(),
        presentationAnchor: anchor()
      )
      try session.setSignedIn(
        user: resp.user,
        tokens: AuthTokens(access: resp.access_token, refresh: resp.refresh_token)
      )
    } catch { errorText = error.localizedDescription }
  }

  @MainActor func signIn() async {
    working = true; defer { working = false }
    do {
      let resp = try await client.login(email: email, presentationAnchor: anchor())
      try session.setSignedIn(
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
