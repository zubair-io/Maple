import MapleCore
import MapleUI
import SwiftUI

/// Shared native owner selector for Timeline and the desktop/phone Search filters.
struct AssetOwnerFilter: View {
  let model: AssetOwnerFilterModel
  @Binding var ownerID: String?
  let params: SearchParams
  var onSelection: () -> Void = {}

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("OWNER")
        .font(MapleTokens.Typography.eyebrow)
        .foregroundStyle(MapleTokens.textMuted)
      // The owner choices come from their own facets request (the owner left
      // out), so they carry their own scope (#4431).
      if let note = model.facetScope.note {
        Text(note)
          .font(MapleTokens.Typography.body)
          .foregroundStyle(MapleTokens.textMuted)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("asset-owner-scope-note")
      }
      MuiSelect(
        value: Binding(
          get: { ownerID ?? "" },
          set: {
            ownerID = $0.isEmpty ? nil : $0
            onSelection()
          }),
        options: model.options(selectedID: ownerID).map {
          MuiSelectOption(value: $0.id, label: $0.label)
        },
        accessibilityLabel: "Asset owner"
      )
      .accessibilityIdentifier("asset-owner-filter")
      if model.isLoading {
        ProgressView("Loading owners")
          .controlSize(.small)
      }
      if model.loadError != nil {
        HStack {
          Text("Could not load owners")
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.textMuted)
          Button("Retry") { Task { await model.load(params) } }
            .accessibilityLabel("Retry loading owners")
            .accessibilityIdentifier("asset-owner-retry")
        }
      }
    }
    .task(id: AssetOwnerFilterModel.scope(for: params)) {
      await model.load(params)
    }
  }
}
