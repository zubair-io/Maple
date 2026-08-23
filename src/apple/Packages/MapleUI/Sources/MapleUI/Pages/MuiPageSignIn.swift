// MuiPageSignIn.swift — Maple UI Pages (unified-component-catalog.md §6).
// App Shell hosting a centered Form Field + Button + Banner group — Maple
// Self Hosted's sign-in screen (native login handoff lands you here first
// on a fresh device; see #2963).
//
// Cross-organism wiring that's genuinely new at this tier: whether the
// Sign In button is enabled at all, and what the Banner says after a
// submit attempt. Both come from `MuiPageSignIn`'s pure reducers so the
// email/password-shaped validation and the mock credential check are
// unit-testable without driving a live form.

import SwiftUI

public struct MuiPageSignIn: View {
    public let signedIn: (() -> Void)?

    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var errorMessage: String?

    public init(signedIn: (() -> Void)? = nil) {
        self.signedIn = signedIn
    }

    private var canSubmit: Bool {
        Self.canSubmit(email: email, password: password)
    }

    public var body: some View {
        MuiAppShell {
            EmptyView()
        } content: {
            VStack(spacing: MuiTokens.spacingLg) {
                Spacer()

                VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                    MuiText("Sign in to Maple", variant: .sheetTitle)
                    MuiText("Self Hosted at maple.local", variant: .body, color: .muted)

                    if let errorMessage {
                        MuiBanner(variant: .error, message: errorMessage)
                    }

                    MuiFormField(label: "Email", value: $email, placeholder: "name@example.com", onCommit: submit)
                    MuiFormField(label: "Password", value: $password, placeholder: "••••••••", onCommit: submit)

                    MuiButton(label: "Sign In", variant: .primary, isLoading: submitting, disabled: !canSubmit || submitting) { submit() }
                }
                .frame(maxWidth: 320)
                .padding(MuiTokens.spacingLg)
                .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))

                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(MuiTokens.bg)
    }

    private func submit() {
        guard canSubmit, !submitting else { return }
        errorMessage = Self.submitError(email: email, password: password)
        if errorMessage == nil {
            signedIn?()
        }
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// The Sign In button is enabled once both fields hold non-whitespace
    /// text — the same "field is present" bar the web reference's login
    /// form applies before it even attempts a request.
    public static func canSubmit(email: String, password: String) -> Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The Banner message after a submit attempt — `nil` on success. Mock
    /// credential check: any syntactically email-shaped address (contains
    /// "@") with a password of at least 4 characters succeeds, mirroring
    /// the shape of a real credential check without a real backend behind
    /// this design-system page.
    public static func submitError(email: String, password: String) -> String? {
        guard email.contains("@") else { return "Enter a valid email address." }
        guard password.count >= 4 else { return "Incorrect email or password." }
        return nil
    }
}

#Preview("MuiPageSignIn") {
    MuiPageSignIn()
        .frame(width: 480, height: 420)
}
