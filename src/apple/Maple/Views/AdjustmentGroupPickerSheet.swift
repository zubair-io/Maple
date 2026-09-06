import MapleCore
import SwiftUI

struct AdjustmentTransferDraft: Identifiable {
  let id = UUID()
  let source: AdjustmentClipboard.Contents
  let targets: [BatchAdjustmentTarget]
  let library: BatchAdjustmentLibrary
}

/// Review the actual target values before submitting a durable transfer.
struct AdjustmentGroupPickerSheet: View {
  let draft: AdjustmentTransferDraft
  let onApply: (BatchAdjustmentRequest) -> Void
  let onCancel: () -> Void
  @State private var groups = Set(AdjustmentGroup.allCases)
  @State private var relativeWhiteBalance = false
  @State private var targetID = ""
  @State private var differences: [AdjustmentGroup: [AdjustmentTransferDifference]] = [:]
  @State private var request: BatchAdjustmentRequest?
  @State private var error: String?
  @State private var isLoading = true

  private var previewKey: String {
    targetID + ":" + String(relativeWhiteBalance) + ":"
      + groups.map(\.rawValue).sorted().joined(separator: ",")
  }

  var body: some View {
    NavigationStack {
      List {
        Section("From \(draft.source.sourceName)") {
          ForEach(AdjustmentGroup.allCases, id: \.self) { group in
            Toggle(
              group.label,
              isOn: Binding(
                get: { groups.contains(group) },
                set: { if $0 { groups.insert(group) } else { groups.remove(group) } })
            )
            .accessibilityIdentifier("paste-group-toggle-\(group.rawValue)")
          }
        }
        if groups.contains(.whiteBalance) {
          Section("White balance") {
            Toggle(
              "Apply the same correction from each camera’s As Shot", isOn: $relativeWhiteBalance
            )
            .accessibilityIdentifier("paste-relative-white-balance")
            Text(
              relativeWhiteBalance
                ? "Each photo keeps its own camera starting point. The copied temperature and tint correction is added to that point."
                : "Each photo receives the copied temperature and tint values."
            )
            .font(.caption).foregroundStyle(.secondary)
          }
        }
        Section("Before → After") {
          Picker("Preview photo", selection: $targetID) {
            ForEach(draft.targets) { target in Text(target.name).tag(target.id) }
          }
          .accessibilityIdentifier("paste-preview-target")
          if isLoading { ProgressView("Reading photo settings…") }
          if let error {
            Text(error).foregroundStyle(.red).accessibilityIdentifier("paste-preview-error")
          }
          if !isLoading && error == nil {
            ForEach(AdjustmentGroup.allCases.filter { groups.contains($0) }, id: \.self) { group in
              VStack(alignment: .leading, spacing: 6) {
                Text(group.label).font(.headline)
                if differences[group, default: []].isEmpty {
                  Text("No change").foregroundStyle(.secondary)
                }
                ForEach(differences[group, default: []]) { field in
                  VStack(alignment: .leading, spacing: 2) {
                    Text(field.label).font(.caption)
                    Text("\(field.before) → \(field.after)").font(.caption.monospacedDigit())
                      .textSelection(.enabled)
                  }
                }
              }
              .accessibilityIdentifier("paste-preview-\(group.rawValue)")
            }
          }
        }
      }
      .navigationTitle("Paste Settings (\(draft.targets.count))")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel).accessibilityIdentifier("paste-group-picker-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Paste") { if let request { onApply(request) } }
            .disabled(isLoading || error != nil || groups.isEmpty || request == nil)
            .accessibilityIdentifier("paste-group-picker-apply")
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 480, minHeight: 560)
    #endif
    .onAppear { if targetID.isEmpty { targetID = draft.targets.first?.id ?? "" } }
    .task(id: previewKey) { await loadPreview() }
  }

  private func loadPreview() async {
    isLoading = true
    request = nil
    error = nil
    do {
      guard let target = draft.targets.first(where: { $0.id == targetID }) else { return }
      let usesRelative = relativeWhiteBalance && groups.contains(.whiteBalance)
      let baseline: WhiteBalanceTransferBaseline?
      if usesRelative {
        guard let source = draft.source.sourceAsset else {
          throw AdjustmentTransferError.missingBaseline
        }
        baseline = try await WhiteBalanceTransferBaseline.read(asset: source)
      } else {
        baseline = nil
      }
      let candidate = BatchAdjustmentRequest(
        source: draft.source.model, groups: groups, relativeWhiteBalance: usesRelative,
        sourceBaseline: baseline)
      let asset = try draft.library.resolve(target)
      let before = try await draft.library.readModel(for: asset)
      let patch = try await draft.library.prepare(target: target, request: candidate)
      let after = patch.applying(to: before)
      let fields = try Dictionary(
        uniqueKeysWithValues: groups.map {
          ($0, try AdjustmentTransferDiff.fields(group: $0, before: before, after: after))
        })
      try Task.checkCancellation()
      differences = fields
      request = candidate
      isLoading = false
    } catch {
      guard !Task.isCancelled else { return }
      self.error = error.localizedDescription
      isLoading = false
    }
  }
}
