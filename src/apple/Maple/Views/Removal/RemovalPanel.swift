import MapleCore
import MapleUI
import SwiftUI
import UniformTypeIdentifiers

struct RemovalPanel: View {
  @Bindable var state: EditorState
  @State private var selectingModels = false
  @State private var importError = ""
  private var removal: RemovalSession { state.removal }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("AI object removal · Local experiment")
        .font(.caption.weight(.semibold))
      MuiSegmentedToggle(
        options: RemovalSession.Mode.allCases.map {
          MuiSegmentedOption(value: $0.rawValue, label: $0.label)
        },
        value: Binding(
          get: { removal.mode.rawValue },
          set: {
            if let mode = RemovalSession.Mode(rawValue: $0) { removal.setMode(mode) }
          }), disabled: removal.phase != .ready)
      if removal.phase == .review {
        reviewControls
      } else if removal.phase == .ready || removal.phase == .selecting {
        selectionControls
        MuiButton(label: "Remove", variant: .primary, disabled: !removal.canRemove) {
          Task { await removal.remove() }
        }.accessibilityIdentifier("removal-generate")
      }
      if removal.busy {
        HStack {
          ProgressView().controlSize(.small)
          Text(removal.phase == .saving ? "Saving removal…" : "Preparing removal…")
            .font(.caption)
        }
        if removal.phase != .saving {
          MuiButton(label: "Cancel", size: .sm) { removal.cancel() }
        }
      }
      if removal.phase == .failed || removal.phase == .closed {
        MuiButton(label: "Retry loading photo", size: .sm) { Task { await removal.open() } }
      }
      if !removal.message.isEmpty || !importError.isEmpty {
        Text(importError.isEmpty ? removal.message : importError)
          .font(.caption).foregroundStyle(ProTokens.textMuted)
          .accessibilityIdentifier("removal-status")
      }
      DisclosureGroup("Local AI models") {
        VStack(alignment: .leading, spacing: 8) {
          Text(
            "Choose a folder containing the pinned model files listed below. Models are verified when used. Photographic quality and device performance are not release-qualified."
          )
          .font(.caption).foregroundStyle(ProTokens.textMuted)
          ForEach(ExperimentalRemovalModels.all, id: \.id) { pin in
            Text(pin.file).font(.caption).textSelection(.enabled)
          }
          if let name = removal.modelFolderName { Text("Selected: \(name)").font(.caption) }
          MuiButton(
            label: "Choose model folder", size: .sm,
            disabled: removal.busy || removal.phase == .review
          ) { selectingModels = true }
        }
      }
    }
    .padding(.horizontal, 14)
    .foregroundStyle(ProTokens.text)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Remove controls")
    .accessibilityIdentifier("removal-panel")
    .fileImporter(isPresented: $selectingModels, allowedContentTypes: [.folder]) { result in
      switch result {
      case .success(let url):
        importError = ""
        Task { await removal.chooseModelFolder(url) }
      case .failure(let error): importError = error.localizedDescription
      }
    }
    .task { await removal.open() }
    .onChange(of: state.session.model) { _, _ in
      guard removal.active, !state.session.isSavingRemoval else { return }
      Task { await removal.open() }
    }
    .onDisappear { removal.close() }
  }

  private var reviewControls: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle(
        "Compare with current photo",
        isOn: Binding(
          get: { removal.compare }, set: { removal.compare = $0 }))
      HStack {
        MuiButton(label: "Keep", variant: .primary) { Task { await removal.keep() } }
          .accessibilityIdentifier("removal-keep")
        MuiButton(label: "Cancel") { removal.cancel() }
      }
      if state.session.sidecarError != nil {
        Text(
          "If another application changed the XMP, close and reopen this photo to load those edits."
        )
        .font(.caption).foregroundStyle(ProTokens.textMuted)
      }
    }
  }

  @ViewBuilder
  private var selectionControls: some View {
    if removal.mode == .people {
      MuiButton(label: "Find people", size: .sm, disabled: removal.busy) {
        Task { await removal.findPeople() }
      }
      Text("Mark the people to keep, then select the others.").font(.caption)
      ForEach(removal.people) { person in
        MuiButton(
          label: "Person \(person.id) · \(person.keep ? "Keep" : "Remove")",
          variant: person.keep ? .primary : .secondary, size: .sm, disabled: removal.busy
        ) {
          removal.keepPerson(person.id)
        }
      }
      MuiButton(
        label: "Select other people", size: .sm,
        disabled: removal.busy || removal.people.isEmpty
      ) { Task { await removal.selectOtherPeople() } }
    } else {
      MuiSegmentedToggle(
        options: [
          MuiSegmentedOption(value: "add", label: "Add"),
          MuiSegmentedOption(value: "subtract", label: "Subtract"),
        ],
        value: Binding(
          get: { removal.subtract ? "subtract" : "add" },
          set: { removal.subtract = $0 == "subtract" }), disabled: removal.busy)
      MuiLivingSlider(
        label: "Brush size",
        value: Binding(
          get: { removal.radius * 100 }, set: { removal.radius = $0 / 100 }),
        range: 0.2...20, step: 0.2, unit: "%", disabled: removal.busy)
      HStack {
        MuiButton(label: "Undo selection", size: .sm, disabled: !removal.canUndoSelection) {
          Task { await removal.undoSelection() }
        }
        MuiButton(label: "Redo selection", size: .sm, disabled: !removal.canRedoSelection) {
          Task { await removal.redoSelection() }
        }
      }
    }
    MuiButton(
      label: "Keep selected area", size: .sm,
      disabled: removal.busy || removal.selection.isEmpty
    ) { removal.protectSelection() }
    HStack {
      MuiButton(
        label: "Clear selection", size: .sm,
        disabled: removal.busy || removal.selection.isEmpty
      ) { removal.clearSelection() }
      MuiButton(
        label: "Clear protection", size: .sm,
        disabled: removal.busy || removal.protection.isEmpty
      ) { removal.clearProtection() }
    }
  }
}
