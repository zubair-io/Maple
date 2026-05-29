// SearchRecentQueries.swift — chip row of last-10 queries for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2 "RECENT".
//
// Persistence in the host (SearchView) via `@AppStorage("cm.search.recent")`
// as a JSON-encoded `[String]`. This view is a dumb renderer so unit
// tests can stub the recents list without touching UserDefaults.

#if os(iOS)

import SwiftUI
import MapleCore

struct SearchRecentQueries: View {
    let recent: [String]
    let onTap: (String) -> Void

    var body: some View {
        if recent.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("RECENT")
                    .font(.custom("Lato-Bold", size: 10))
                    .tracking(0.6)
                    .foregroundStyle(MapleTokens.textMuted)

                FlowChips(items: recent, onTap: onTap)
            }
        }
    }
}

/// Wraps the chips in a horizontal scroll row so a long history doesn't
/// blow out the layout. SwiftUI's `Layout` protocol could give us true
/// wrap-flow, but a single scrollable row matches the mockup and avoids
/// pulling in a new dependency.
private struct FlowChips: View {
    let items: [String]
    let onTap: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.self) { item in
                    Button {
                        onTap(item)
                    } label: {
                        Text(item)
                            .font(.custom("Lato-Regular", size: 12))
                            .foregroundStyle(MapleTokens.textMain)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(MapleTokens.surfaceAlt)
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .stroke(MapleTokens.border, lineWidth: 0.5)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("recent-chip-\(item)")
                }
            }
        }
    }
}

// MARK: - Persistence helpers (pure — testable)

/// Decode the JSON-encoded `cm.search.recent` blob from `@AppStorage`.
/// Returns `[]` on any decode failure so the UI degrades gracefully.
func decodeRecents(_ json: String) -> [String] {
    guard let data = json.data(using: .utf8) else { return [] }
    return (try? JSONDecoder().decode([String].self, from: data)) ?? []
}

/// Encode a recents list back to JSON for storage. Truncates to 10 so
/// the persisted form never exceeds the cap.
func encodeRecents(_ items: [String]) -> String {
    let capped = Array(items.prefix(10))
    guard let data = try? JSONEncoder().encode(capped) else { return "[]" }
    return String(data: data, encoding: .utf8) ?? "[]"
}

/// Push `q` onto a recents list, dedup'd + capped at 10. Empty / whitespace-
/// only queries are ignored. Pure so a unit test owns the contract.
func pushRecent(_ current: [String], _ q: String) -> [String] {
    let trimmed = q.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return current }
    var next = current.filter { $0 != trimmed }
    next.insert(trimmed, at: 0)
    if next.count > 10 { next = Array(next.prefix(10)) }
    return next
}

#Preview("Recent — populated") {
    SearchRecentQueries(
        recent: ["paris", "rooftop", "old town", "moss", "boulder", "haze"],
        onTap: { _ in }
    )
    .padding()
    .background(MapleTokens.bg)
}

#endif
