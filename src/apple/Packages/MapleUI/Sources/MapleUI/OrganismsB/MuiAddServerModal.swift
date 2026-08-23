// MuiAddServerModal.swift — Maple UI Organisms · Modals (unified-component-
// catalog.md §4.4). Sign-in/registration for a remote Maple Self Hosted
// server, built on Overlay Shell from Form Field, Button, Banner.
//
// The password field rides on Form Field's plain-text control, same as the
// web reference — `MuiInput` has no masked/password variant today.

import SwiftUI

public struct MuiAddServerRequest: Sendable {
    public let host: String
    public let username: String
    public let password: String
}

public struct MuiAddServerModal: View {
    public let isPresented: Bool
    public let contained: Bool
    @Binding public var host: String
    @Binding public var username: String
    @Binding public var password: String
    public let connecting: Bool
    public let error: String?
    public let connectRequested: ((MuiAddServerRequest) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        host: Binding<String>,
        username: Binding<String>,
        password: Binding<String>,
        connecting: Bool = false,
        error: String? = nil,
        connectRequested: ((MuiAddServerRequest) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self._host = host
        self._username = username
        self._password = password
        self.connecting = connecting
        self.error = error
        self.connectRequested = connectRequested
        self.dismissed = dismissed
    }

    private var canConnect: Bool {
        Self.canConnect(host: host, username: username, connecting: connecting)
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, size: .sm, accessibilityLabel: "Add Server", contained: contained) {
            MuiText("Add Server", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                MuiFormField(label: "Server host", value: $host, placeholder: "maple.local")
                MuiFormField(label: "Username", value: $username)
                MuiFormField(label: "Password", value: $password)
                if let error {
                    MuiBanner(variant: .error, message: error)
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Connect", variant: .primary, isLoading: connecting, disabled: !canConnect) {
                    connectRequested?(MuiAddServerRequest(host: host, username: username, password: password))
                }
            }
        } dismissed: {
            dismissed?()
        }
    }

    /// Whether Connect is enabled — a non-blank host and username, and not
    /// already connecting. Public + static so this is unit-testable without
    /// rendering a view.
    public static func canConnect(host: String, username: String, connecting: Bool) -> Bool {
        !host.trimmingCharacters(in: .whitespaces).isEmpty
            && !username.trimmingCharacters(in: .whitespaces).isEmpty
            && !connecting
    }
}

#Preview("MuiAddServerModal") {
    struct Demo: View {
        @State private var open = false
        @State private var host = ""
        @State private var username = ""
        @State private var password = ""
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Add Server", variant: .primary) { open = true }
                MuiAddServerModal(isPresented: open, host: $host, username: $username, password: $password, dismissed: { open = false })
            }
            .frame(width: 380, height: 320)
        }
    }
    return Demo()
}
