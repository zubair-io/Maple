// KeywordChipsRow.swift — S6 Info content, section 4.
//
// Editable in #632. The component reads the live `culling.keywords` list
// off the EditSession and mutates it through `setKeywords(_:)`, which
// routes through `culling.didSet` → the existing 750ms-debounced
// `XMPSidecarStore.update` write. There's no separate render kick because
// keywords have zero pixel impact.
//
// What renders:
//   • Existing keywords (`session.culling.keywords`) as 11pt rounded chips
//     on `surfaceAlt`. Tapping a chip removes it — the whole chip is the
//     button so the hit target stays comfortable at 11pt type.
//   • A trailing dashed `+ Add` chip. Tapping it expands an inline
//     `TextField` docked next to the chip row; the field auto-focuses,
//     submits on Return / commit, and collapses again. On phones the
//     keyboard docks against the field automatically (SwiftUI's default
//     `TextField` keyboard-docking behaviour applies — no manual
//     `.keyboardType` / `.submitLabel` overrides needed beyond `.done`).

import MapleCore
import SwiftUI

// MARK: - KeywordChipsRow

struct KeywordChipsRow: View {
  /// Live session — `nil` when no asset is focused. Render-disabled state
  /// matches `RatingFlagsRow`'s pattern so the inspector layout doesn't
  /// jump while waiting for hydration.
  let session: EditSession?

  /// Draft text for the inline add field. Only non-empty while the user
  /// is mid-type; cleared on submit / cancel.
  @State private var draft: String = ""

  /// Visibility of the inline add field. `true` after tapping the `+`
  /// chip; collapses on submit / cancel / focus loss.
  @State private var isEditing: Bool = false

  /// Focus binding so the field auto-focuses when it appears and so
  /// `.onSubmit` can clear focus alongside committing the draft.
  @FocusState private var fieldFocused: Bool

  private var keywords: [String] {
    session?.culling.keywords ?? []
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Keywords")
      FlowLayout(spacing: 6) {
        ForEach(keywords, id: \.self) { keyword in
          KeywordChip(text: keyword, onTap: { removeKeyword(keyword) })
        }
        if isEditing {
          AddKeywordField(
            draft: $draft,
            focused: $fieldFocused,
            onSubmit: applyAddDraft,
            onCancel: cancelAddDraft
          )
        } else {
          AddKeywordChip(onTap: openAddDraft)
        }
      }
    }
    .disabled(session == nil)
    .opacity(session == nil ? 0.5 : 1.0)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-keywords")
    // Collapse the inline add field when it loses focus (iOS/iPadOS
    // "empty-blur" path called out in the header doc). The `isEditing`
    // guard stops `openAddDraft`'s async focus-grab from firing this
    // closure before the field has actually mounted, and stops
    // `applyAddDraft` / `cancelAddDraft` (which also drop focus) from
    // re-entering. A non-empty draft commits; an empty draft cancels.
    .onChange(of: fieldFocused) { _, focused in
      guard isEditing, !focused else { return }
      let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty {
        cancelAddDraft()
      } else {
        applyAddDraft()
      }
    }
  }

  private func openAddDraft() {
    draft = ""
    isEditing = true
    // Defer focus by one runloop pass so SwiftUI mounts the TextField
    // before the focus binding tries to claim it. Without the dispatch
    // the very first `+` tap sometimes ends up with no keyboard.
    DispatchQueue.main.async {
      fieldFocused = true
    }
  }

  private func applyAddDraft() {
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let session else { return }
    if !trimmed.isEmpty {
      session.setKeywords(session.culling.keywords + [trimmed])
    }
    draft = ""
    isEditing = false
    fieldFocused = false
  }

  private func cancelAddDraft() {
    draft = ""
    isEditing = false
    fieldFocused = false
  }

  private func removeKeyword(_ keyword: String) {
    guard let session else { return }
    session.setKeywords(session.culling.keywords.filter { $0 != keyword })
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

// MARK: - AddKeywordField

/// Inline draft input that replaces the `+` chip while the user is
/// typing a new keyword. Submits on Return (`.done` keyboard submit),
/// cancels on Escape (macOS) or on empty-blur (iOS/iPadOS). Width is
/// content-sized rather than fixed so the field flows naturally inside
/// `FlowLayout` next to the existing chips.
struct AddKeywordField: View {
  @Binding var draft: String
  var focused: FocusState<Bool>.Binding
  let onSubmit: () -> Void
  let onCancel: () -> Void

  var body: some View {
    HStack(spacing: 3) {
      TextField("New keyword", text: $draft)
        .textFieldStyle(.plain)
        .font(MapleTokens.Typography.chipLabel)
        .foregroundStyle(MapleTokens.textMain)
        .focused(focused)
        .submitLabel(.done)
        .onSubmit(onSubmit)
        .frame(minWidth: 48)
        .fixedSize(horizontal: true, vertical: false)
        // macOS catches Escape via `onExitCommand`; iOS doesn't ship that
        // modifier. The iOS dismissal path is keyboard-down or empty-blur.
        .modifier(EscapeCancelModifier(onCancel: onCancel))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 4)
    .background(
      Capsule()
        .stroke(
          MapleTokens.borderHi,
          style: StrokeStyle(lineWidth: 1, dash: [3, 2])
        )
    )
    .accessibilityLabel("New keyword")
    .accessibilityIdentifier("info-panel-keyword-input")
  }
}

/// Hosts the macOS-only Escape-to-cancel modifier behind an `#if`. iOS
/// builds get a no-op so the call site doesn't need a platform branch.
private struct EscapeCancelModifier: ViewModifier {
  let onCancel: () -> Void

  func body(content: Content) -> some View {
    #if os(macOS)
    content.onExitCommand(perform: onCancel)
    #else
    content
    #endif
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

#Preview("KeywordChipsRow — empty") {
  KeywordChipsRow(session: nil)
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}
