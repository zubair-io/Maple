// AddMapleCloudSheet.swift
//
// Single sheet that drives the AddMapleCloud flow. Two panels:
//   .idle              → domain entry text field
//   .loadingWebview    → embedded WKWebView pointed at <domain>
//   .signedIn          → dismisses on entry
//   .error             → inline message + Try again
//
// The webview is the auth UI — the native side has no sign-in form.
// See WebViewSignInPanel.swift for the WKWebView + JS-bridge plumbing.

import SwiftUI
import MapleCore

struct AddMapleCloudSheet: View {
  let onDismiss: () -> Void
  let onSignedIn: @MainActor (URL, AuthTokens, AuthUser) -> Void

  @State private var vm: AddMapleCloudViewModel

  init(prefilledDomain: String = "",
       onDismiss: @escaping () -> Void,
       onSignedIn: @escaping @MainActor (URL, AuthTokens, AuthUser) -> Void) {
    self.onDismiss = onDismiss
    self.onSignedIn = onSignedIn
    let viewModel = AddMapleCloudViewModel(onSignedIn: onSignedIn)
    viewModel.domainInput = prefilledDomain
    _vm = State(wrappedValue: viewModel)
  }

  /// Centralized dismiss path. Cancels any pending webview message
  /// delivery so a stray `auth_success` post arriving after the user
  /// closed the sheet does NOT silently register the server.
  private func dismiss() {
    vm.cancel()
    onDismiss()
  }

  var body: some View {
    VStack(spacing: 0) {
      panel
    }
    .frame(minWidth: 480, minHeight: 320)
    .onDisappear { vm.cancel() }
    .onChange(of: vm.state) { _, newValue in
      if case .signedIn = newValue { onDismiss() }
    }
  }

  // MARK: - Panel router

  @ViewBuilder
  private var panel: some View {
    switch vm.state {
    case .idle:                        idlePanel
    case .loadingWebview(let host):    webviewPanel(host: host)
    case .signedIn(let host, _, _):    spinnerPanel("Signed in to \(host.displayHost).")
    case .error(let msg, _):           errorPanel(message: msg)
    }
  }

  // MARK: - Panels

  private var idlePanel: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Add a Maple Cloud server").font(.title3).bold()
      Text("Type the server's domain. Sign-in happens in a secure window inside the app.")
        .foregroundStyle(.secondary).font(.callout)
      TextField("myserver.com", text: $vm.domainInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        #endif
        .onSubmit { vm.continueFromIdle() }
      HStack {
        Spacer()
        Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
        Button("Continue") { vm.continueFromIdle() }
          .keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent)
          .disabled(vm.domainInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(28)
  }

  private func webviewPanel(host: CloudHost) -> some View {
    VStack(spacing: 0) {
      // Slim header so the user always knows which domain is loaded
      // and can back out without hunting for the close button.
      HStack {
        Text(host.displayHost)
          .font(.callout.weight(.medium))
          .foregroundStyle(.secondary)
        Spacer()
        Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      Divider()
      WebViewSignInPanel(
        host: host,
        onAuthSuccess: { access, refresh, user in
          vm.bridgeReceivedAuthSuccess(accessToken: access,
                                       refreshToken: refresh,
                                       user: user)
        },
        onLoadFailure: { message in
          vm.webviewFailed(message: message)
        }
      )
    }
  }

  private func spinnerPanel(_ message: String) -> some View {
    VStack(spacing: 12) {
      ProgressView()
      Text(message).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(28)
  }

  private func errorPanel(message: String) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(message, systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(.red).font(.callout)
      HStack {
        Spacer()
        Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
        Button("Try again") { vm.retryFromError() }
          .keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent)
      }
    }
    .padding(28)
  }
}
