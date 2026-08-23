// MuiResponseViewer.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Formatted response with status, built from Code Block,
// Badge, Tabs.

import SwiftUI

public struct MuiResponseViewer: View {
    public let status: Int
    public let statusText: String
    public let body_: String
    public let headers: String
    @Binding public var activeId: String

    private static let tabs: [MuiTab] = [
        MuiTab(id: "body", label: "Body"),
        MuiTab(id: "headers", label: "Headers"),
    ]

    public init(status: Int, statusText: String = "", body: String, headers: String = "", activeId: Binding<String> = .constant("body")) {
        self.status = status
        self.statusText = statusText
        self.body_ = body
        self.headers = headers
        self._activeId = activeId
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            HStack {
                MuiBadge(variant: Self.statusVariant(status: status), value: Self.statusLabel(status: status, statusText: statusText))
                Spacer()
                MuiTabs(tabs: Self.tabs, activeId: $activeId, accessibilityLabel: "Response tabs")
            }
            MuiCodeBlock(code: Self.activeContent(activeId: activeId, body: body_, headers: headers))
        }
    }

    /// The badge caption combining status code and reason phrase. Public +
    /// static so this is unit-testable without rendering a view.
    public static func statusLabel(status: Int, statusText: String) -> String {
        "\(status) \(statusText)".trimmingCharacters(in: .whitespaces)
    }

    /// `.signal` for a successful (< 400) response, `.count` otherwise.
    /// Public + static so this is unit-testable without rendering a view.
    public static func statusVariant(status: Int) -> MuiBadgeVariant {
        status < 400 ? .signal : .count
    }

    /// The code block's content for the active tab. Public + static so
    /// this is unit-testable without rendering a view.
    public static func activeContent(activeId: String, body: String, headers: String) -> String {
        activeId == "headers" ? headers : body
    }
}

#Preview("MuiResponseViewer") {
    struct Demo: View {
        @State private var activeId = "body"

        var body: some View {
            MuiResponseViewer(
                status: 200,
                statusText: "OK",
                body: "{\n  \"id\": \"IMG_0042\"\n}",
                headers: "content-type: application/json",
                activeId: $activeId
            )
            .padding()
            .frame(width: 340)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
