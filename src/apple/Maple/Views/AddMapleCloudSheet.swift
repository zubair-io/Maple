// AddMapleCloudSheet.swift
//
// Single sheet that drives the AddMapleCloud sign-in flow. Two visible
// panels:
//   .idle              → domain entry text field
//   .authenticating    → spinner while ASWebAuthenticationSession is up
//                        (the actual auth UI is system-presented; our
//                        sheet stays in the background)
//   .signedIn          → dismisses on entry
//   .error             → inline message + Try again

import SwiftUI
import MapleCore

struct AddMapleCloudSheet: View {
  let onDismiss: () -> Void
  let onSignedIn: @MainActor (URL, AuthTokens, AuthUser) -> Void

  @State private var vm: AddMapleCloudViewModel
  @State private var driver = ASWebAuthSessionDriver()

  init(prefilledDomain: String = "",
       onDismiss: @escaping () -> Void,
       onSignedIn: @escaping @MainActor (URL, AuthTokens, AuthUser) -> Void) {
    self.onDismiss = onDismiss
    self.onSignedIn = onSignedIn
    let viewModel = AddMapleCloudViewModel(onSignedIn: onSignedIn)
    viewModel.domainInput = prefilledDomain
    _vm = State(wrappedValue: viewModel)
  }

  /// Centralized dismiss path. Cancels both the in-flight session and
  /// suppresses any late driver callback.
  private func dismiss() {
    vm.cancel()
    driver.cancel()
    onDismiss()
  }

  var body: some View {
    VStack(spacing: 16) {
      panel
    }
    .padding(28)
    .frame(minWidth: 420, minHeight: 240)
    .onDisappear {
      vm.cancel()
      driver.cancel()
    }
    .onChange(of: vm.state) { _, newValue in
      if case .signedIn = newValue { onDismiss() }
    }
  }

  // MARK: - Panel router

  @ViewBuilder
  private var panel: some View {
    switch vm.state {
    case .idle:                        idlePanel
    case .authenticating(let host):    authenticatingPanel(host: host)
    case .signedIn(let host, _, _):    spinnerPanel("Signed in to \(host.displayHost).")
    case .error(let msg, _):           errorPanel(message: msg)
    }
  }

  // MARK: - Panels

  private var idlePanel: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Add a Maple Cloud server").font(.title3).bold()
      Text("Type the server's domain. Sign-in opens in a secure system window.")
        .foregroundStyle(.secondary).font(.callout)
      TextField("myserver.com", text: $vm.domainInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        #endif
        .onSubmit { startSession() }
      HStack {
        Spacer()
        Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
        Button("Continue") { startSession() }
          .keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent)
          .disabled(vm.domainInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }

  private func authenticatingPanel(host: CloudHost) -> some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Signing in to \(host.displayHost)…")
        .foregroundStyle(.secondary)
      Text("Complete the sign-in in the secure window.")
        .font(.caption)
        .foregroundStyle(.secondary)
      Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
    }
    .frame(maxWidth: .infinity, alignment: .center)
  }

  private func spinnerPanel(_ message: String) -> some View {
    VStack(spacing: 12) {
      ProgressView()
      Text(message).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .center)
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
  }

  // MARK: - Session lifecycle

  private func startSession() {
    guard let host = vm.continueFromIdle() else { return }
    driver.start(host: host) { result in
      switch result {
      case .success(let tokens, let user):
        vm.driverReceivedAuthSuccess(tokens: tokens, user: user)
      case .cancelled:
        vm.driverCancelled()
      case .failed(let msg):
        vm.driverFailed(message: msg)
      }
    }
  }
}

// MARK: - Previews
//
// Issue #139 — sign-in sheet. The sheet builds its own VM internally; for
// preview purposes only the `prefilledDomain` knob is observable. To
// preview authenticating / error panels in isolation, see the
// AddMapleCloudViewModel.preview(...) factory in MapleCore.

#Preview("Default — empty domain") {
    AddMapleCloudSheet(
        prefilledDomain: "",
        onDismiss: {},
        onSignedIn: { _, _, _ in }
    )
}

#Preview("Prefilled domain") {
    AddMapleCloudSheet(
        prefilledDomain: "myserver.example.com",
        onDismiss: {},
        onSignedIn: { _, _, _ in }
    )
}
