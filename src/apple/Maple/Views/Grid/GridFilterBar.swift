import MapleCore
import MapleUI
import SwiftUI

/// Shared filter controls for the phone Library and Mac/iPad Browse grids.
struct GridFilterBar: View {
  let vm: BrowseViewModel
  let readMetadata: @MainActor @Sendable (AssetRef) async throws -> GridFilterMetadata
  let matchingCount: Int
  /// `.horizontal` keeps the status beside the chips, for the one-row iPad header (#5435).
  var axis: Axis = .vertical

  private var loadKey: String {
    "\(vm.gridFilter.rawValue)-\(vm.listingGeneration)-\(vm.assets.count)-\(vm.gridFilterAssetIdentityGeneration)"
  }

  var body: some View {
    let layout =
      axis == .vertical
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
      : AnyLayout(HStackLayout(spacing: 8))
    return layout {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(GridFilter.allCases, id: \.self) { filter in
            Button(filter.title) { vm.selectGridFilter(filter) }
              .font(.system(size: 11, weight: .bold))
              .foregroundStyle(
                vm.gridFilter == filter ? MapleTokens.primary : MapleTokens.textMuted
              )
              .padding(.horizontal, 10)
              .frame(minHeight: 28)
              .background(
                vm.gridFilter == filter
                  ? MapleTokens.primary.opacity(0.22) : MapleTokens.surfaceAlt,
                in: Capsule()
              )
              .overlay {
                Capsule().strokeBorder(
                  vm.gridFilter == filter ? MapleTokens.primary : MapleTokens.border,
                  lineWidth: 0.5)
              }
              .buttonStyle(.plain)
              .accessibilityIdentifier("grid-filter-\(filter.rawValue)")
              .accessibilityAddTraits(vm.gridFilter == filter ? .isSelected : [])
          }
        }
        .padding(.horizontal, 8)
      }
      if vm.gridFilterLoading {
        ProgressView("Filtering photos…")
          .padding(.horizontal, 8)
          .accessibilityIdentifier("grid-filter-loading")
      } else if let error = vm.gridFilterError {
        HStack {
          Text("Couldn’t read photo ratings: \(error.localizedDescription)")
            .lineLimit(axis == .vertical ? nil : 1)
          Button("Retry") { Task { await loadFilter() } }
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .accessibilityIdentifier("grid-filter-error")
      } else if vm.gridFilter != .all,
        vm.gridFilterMetadata.count == vm.assets.count,
        matchingCount == 0
      {
        Text("No matching photos")
          .font(.caption)
          .foregroundStyle(MapleTokens.textMuted)
          .padding(.horizontal, 8)
          .accessibilityIdentifier("grid-filter-empty")
      }
    }
    .task(id: loadKey) {
      await loadFilter()
    }
  }

  @MainActor
  private func loadFilter() async {
    if vm.gridFilter != .all { vm.gridFilterLoading = true }
    do {
      try await vm.loadRemainingPhotoKitForFilter()
      try Task.checkCancellation()
      await vm.loadGridFilterMetadata(read: readMetadata)
    } catch {
      guard !Task.isCancelled else { return }
      vm.gridFilterLoading = false
      vm.gridFilterError = error
    }
  }
}
