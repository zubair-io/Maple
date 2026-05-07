// AddMapleCloudSheet.swift
//
// Single sheet that drives the entire AddMapleCloud flow. Renders one panel
// per AddMapleCloudViewModel state. The view contains zero business logic —
// every action calls a method on the view model.

import SwiftUI
import AuthenticationServices
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

  var body: some View {
    VStack(spacing: 16) {
      panel
    }
    .padding(28)
    .frame(minWidth: 420, minHeight: 240)
    .onAppear {
      vm.presentationAnchor = anchorProvider
    }
    .onChange(of: vm.state) { _, newValue in
      if case .signedIn = newValue { onDismiss() }
    }
  }

  // MARK: - Panel router

  @ViewBuilder
  private var panel: some View {
    switch vm.state {
    case .idle:                            idlePanel
    case .checkingBootstrap(let host):     spinnerPanel("Connecting to \(host.displayHost)…")
    case .needsOwnerClaim(let host):       ownerClaimPanel(host: host)
    case .registeringOwner(let host, _):   spinnerPanel("Creating owner account at \(host.displayHost)…")
    case .needsAuth(let host):             needsAuthPanel(host: host)
    case .enteringSignInEmail(let host):   signInEmailPanel(host: host)
    case .signingIn(let host, _):          spinnerPanel("Signing in to \(host.displayHost)…")
    case .enteringInviteDetails(let host): inviteDetailsPanel(host: host)
    case .registeringInvitee(let host, _, _): spinnerPanel("Joining \(host.displayHost)…")
    case .signedIn:                        spinnerPanel("Signed in.")
    case .error(let msg, _):               errorPanel(message: msg)
    }
  }

  // MARK: - Panels

  private var idlePanel: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Add a Maple Cloud server").font(.title3).bold()
      TextField("myserver.com", text: $vm.domainInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        #endif
        .onSubmit { Task { await vm.continueFromIdle() } }
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button("Continue") { Task { await vm.continueFromIdle() } }
          .keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent)
          .disabled(vm.domainInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }

  private func spinnerPanel(_ message: String) -> some View {
    VStack(spacing: 12) {
      ProgressView()
      Text(message).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .center)
  }

  private func ownerClaimPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Set up \(host.displayHost)").font(.title3).bold()
      Text("This server has no account yet. Enter your email — you'll be the owner.")
        .foregroundStyle(.secondary).font(.callout)
      TextField("you@example.com", text: $vm.emailInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.emailAddress)
        #endif
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button { Task { await vm.claimOwner() } } label: {
          Label("Create owner account", systemImage: "key.fill")
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .disabled(vm.emailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }

  private func needsAuthPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Sign in to \(host.displayHost)").font(.title3).bold()
      Text("How would you like to continue?").foregroundStyle(.secondary).font(.callout)
      HStack {
        Button { vm.chooseSignIn() } label: {
          Label("Sign in", systemImage: "person.fill")
        }
        Button { vm.chooseJoinWithInvite() } label: {
          Label("Join with invite", systemImage: "envelope.fill")
        }
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
      }
    }
  }

  private func signInEmailPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Sign in to \(host.displayHost)").font(.title3).bold()
      TextField("you@example.com", text: $vm.emailInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.emailAddress)
        #endif
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button { Task { await vm.signIn() } } label: {
          Label("Sign in with passkey", systemImage: "key.fill")
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .disabled(vm.emailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }

  private func inviteDetailsPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Join \(host.displayHost)").font(.title3).bold()
      TextField("Email", text: $vm.emailInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.emailAddress)
        #endif
      TextField("Invite code", text: $vm.inviteInput)
        .textFieldStyle(.roundedBorder)
        .textCase(.uppercase)
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button { Task { await vm.joinWithInvite() } } label: {
          Label("Join with passkey", systemImage: "key.fill")
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .disabled(vm.emailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || vm.inviteInput.trimmingCharacters(in: .whitespacesAndNewlines).count != 8)
      }
    }
  }

  private func errorPanel(message: String) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(message, systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(.red).font(.callout)
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button("Try again") { vm.retryFromError() }
          .keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent)
      }
    }
  }

  // MARK: - Anchor

  @MainActor
  private func anchorProvider() -> ASPresentationAnchor {
    #if os(macOS)
    return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
    #else
    return UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first ?? ASPresentationAnchor()
    #endif
  }
}
