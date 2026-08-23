// MuiEndpointForm.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Interactive request builder, built from Form Field,
// Button, Badge.

import SwiftUI

public struct MuiEndpointRequest: Sendable {
    public let method: String
    public let url: String

    public init(method: String, url: String) {
        self.method = method
        self.url = url
    }
}

public struct MuiEndpointForm: View {
    public let methods: [String]
    @Binding public var method: String
    @Binding public var url: String
    public let sending: Bool
    public let send: ((MuiEndpointRequest) -> Void)?

    public init(
        methods: [String] = ["GET", "POST", "PUT", "DELETE"],
        method: Binding<String>,
        url: Binding<String>,
        sending: Bool = false,
        send: ((MuiEndpointRequest) -> Void)? = nil
    ) {
        self.methods = methods
        self._method = method
        self._url = url
        self.sending = sending
        self.send = send
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            HStack(spacing: MuiTokens.spacingXs) {
                ForEach(methods, id: \.self) { candidate in
                    Button {
                        method = candidate
                    } label: {
                        MuiBadge(variant: candidate == method ? .signal : .count, value: candidate)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(candidate == method ? [.isButton, .isSelected] : .isButton)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("HTTP method")

            MuiFormField(label: "URL", value: $url, placeholder: "/api/photos")

            MuiButton(label: "Send", variant: .primary, isLoading: sending) {
                send?(MuiEndpointRequest(method: method, url: url))
            }
        }
    }
}

#Preview("MuiEndpointForm") {
    struct Demo: View {
        @State private var method = "GET"
        @State private var url = "/api/photos"

        var body: some View {
            MuiEndpointForm(method: $method, url: $url)
                .padding()
                .frame(width: 300)
                .background(MuiTokens.bg)
        }
    }
    return Demo()
}
