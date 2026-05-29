// KeywordChipsRow.swift — S6 Info content, section 4.
//
// READ-ONLY in v0.1. `EditSession` does not expose a `setKeywords(_:)`
// method today; `AdjustmentModel` doesn't carry a keywords field; and
// `XMPParser` round-trips Adobe `crs:` attributes but not `dc:subject`
// (the IPTC keyword bag). Shipping write-through would mean adding:
//   • a new XMP namespace serialization path,
//   • a new field on the model + culling round-trip,
//   • a new EditSession mutator that routes through the existing 750ms
//     `XMPSidecarStore.update` debounce.
// Per spec §6 risk 3, default plan (a): chip-editing affordance is a
// stub. Follow-up ticket: "S6 keyword editing — XMP dc:subject round-
// trip + EditSession.setKeywords".
//
// What renders in v0.1:
//   • Existing keywords (an empty list today; the model doesn't surface
//     any yet) as 11pt rounded chips on `surfaceAlt`.
//   • A trailing dashed `+` add-chip that opens an alert explaining the
//     feature isn't wired yet. Keeps the affordance visible so users +
//     reviewers can see where it lands, but doesn't mutate state.
//
// When the model work lands, the `+` chip switches to docking a single-
// line text input above the keyboard and the chips become tappable for
// removal. The `applyAddDraft` / `removeKeyword` private methods below
// are the no-op stubs that the follow-up replaces.

import MapleCore
import SwiftUI

// MARK: - KeywordChipsRow

struct KeywordChipsRow: View {
  let asset: AssetRef?

  /// Local draft text for the future "+ add" input. Wired up now so
  /// the follow-up ticket only swaps the alert for an inline field.
  @State private var draft: String = ""
  @State private var showStubAlert: Bool = false

  /// v0.1 keywords source. Today this is always empty — the model
  /// doesn't carry a keywords field and we don't read `dc:subject`
  /// from the sidecar. Surfacing the existing-data hook here keeps
  /// the wiring honest: the day the model gains keywords, this is
  /// the only line that changes.
  private var keywords: [String] {
    // TODO(s6-keyword-editing): read from session/model once the
    // dc:subject round-trip lands. Returning [] today produces a
    // chips row with just the "+" affordance, which matches the
    // current XMP read path (no keywords parsed = no chips shown).
    []
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Keywords")
      FlowLayout(spacing: 6) {
        ForEach(keywords, id: \.self) { keyword in
          KeywordChip(text: keyword, onTap: { removeKeyword(keyword) })
        }
        AddKeywordChip(onTap: openAddDraft)
      }
    }
    .alert("Keyword editing coming soon", isPresented: $showStubAlert) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("XMP keyword round-trip lands in a follow-up ticket.")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-keywords")
  }

  /// v0.1 stub. Replace with sheet/inline input + EditSession mutator
  /// in the follow-up.
  private func openAddDraft() {
    draft = ""
    showStubAlert = true
  }

  private func applyAddDraft() {
    // TODO(s6-keyword-editing): session.setKeywords(keywords + [draft]).
  }

  private func removeKeyword(_ keyword: String) {
    // TODO(s6-keyword-editing): session.setKeywords(keywords.filter { $0 != keyword }).
  }

  private func sectionHeader(_ title: String) -> some View {
    Text(title.uppercased())
      .font(MapleTokens.Typography.eyebrow)
      .foregroundStyle(MapleTokens.textMuted)
      .tracking(1.4)
  }
}

// MARK: - KeywordChip

struct KeywordChip: View {
  let text: String
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      Text(text)
        .font(MapleTokens.Typography.chipLabel)
        .foregroundStyle(MapleTokens.textMain)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(MapleTokens.surfaceAlt, in: Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Keyword: \(text). Tap to remove.")
    .accessibilityIdentifier("info-panel-keyword-\(text)")
  }
}

// MARK: - AddKeywordChip

struct AddKeywordChip: View {
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 3) {
        Image(systemName: "plus")
          .font(.system(size: 10, weight: .semibold))
        Text("Add")
          .font(MapleTokens.Typography.chipLabel)
      }
      .foregroundStyle(MapleTokens.textMuted)
      .padding(.horizontal, 10)
      .padding(.vertical, 4)
      .background(
        Capsule()
          .stroke(
            MapleTokens.borderHi,
            style: StrokeStyle(lineWidth: 1, dash: [3, 2])
          )
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Add keyword")
    .accessibilityIdentifier("info-panel-keyword-add")
  }
}

// MARK: - FlowLayout

/// Wrap-on-overflow horizontal layout for the chip row. SwiftUI doesn't
/// ship a built-in flow / "wrap" stack; this is the minimum viable Layout
/// implementation — measure each subview at its ideal size, place left-
/// to-right, wrap when the next item would exceed `proposal.width`.
struct FlowLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout Void
  ) -> CGSize {
    let width = proposal.width ?? .infinity
    var rowWidth: CGFloat = 0
    var rowHeight: CGFloat = 0
    var totalHeight: CGFloat = 0
    var maxWidth: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if rowWidth + size.width > width && rowWidth > 0 {
        totalHeight += rowHeight + spacing
        maxWidth = max(maxWidth, rowWidth - spacing)
        rowWidth = 0
        rowHeight = 0
      }
      rowWidth += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    totalHeight += rowHeight
    maxWidth = max(maxWidth, rowWidth - spacing)
    return CGSize(width: max(0, maxWidth), height: totalHeight)
  }

  func placeSubviews(
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout Void
  ) {
    let width = bounds.width
    var x = bounds.minX
    var y = bounds.minY
    var rowHeight: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x + size.width > bounds.minX + width && x > bounds.minX {
        x = bounds.minX
        y += rowHeight + spacing
        rowHeight = 0
      }
      subview.place(
        at: CGPoint(x: x, y: y),
        anchor: .topLeading,
        proposal: ProposedViewSize(size)
      )
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}

// MARK: - Previews

#Preview("KeywordChipsRow — empty (v0.1 default)") {
  KeywordChipsRow(asset: .preview())
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}
