import MapleCore
import MapleUI
import SwiftUI
import UniformTypeIdentifiers

struct RemovalPanel: View {
  @Bindable var state: EditorState
  var showsModePicker = true
  @State private var selectingModels = false
  @State private var importError = ""
  @State private var showingSavedRemovals = false
  private var removal: RemovalSession { state.removal }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(showsModePicker ? "AI object removal" : removal.mode.panelTitle)
        .font(.headline.weight(.semibold))
      if removal.phase != .ready && removal.phase != .selecting { statusMessage }
      if showsModePicker {
        MuiSegmentedToggle(
          options: RemovalSession.Mode.allCases.map {
            MuiSegmentedOption(value: $0.rawValue, label: $0.label)
          },
          value: Binding(
            get: { removal.mode.rawValue },
            set: {
              if let mode = RemovalSession.Mode(rawValue: $0) {
                Task { await removal.setMode(mode) }
              }
            }), disabled: removal.phase != .ready || removal.replacingRemovalID != nil)
      }
      if showsModePicker { savedControls }
      if removal.phase == .review {
        reviewControls
      } else if removal.phase == .ready || removal.phase == .selecting {
        selectionControls
        statusMessage
        MuiButton(
          label: removal.requiresProtectionReview ? "Remove unprotected parts" : "Remove",
          variant: .primary, disabled: !removal.canRemove
        ) {
          Task {
            if removal.requiresProtectionReview {
              await removal.removeUnprotectedParts()
            } else {
              await removal.remove()
            }
          }
        }.accessibilityIdentifier("removal-generate")
      }
      if removal.busy {
        HStack {
          ProgressView().controlSize(.small)
          Text(removal.phase == .saving ? "Saving removal…" : "Working…")
            .font(.caption)
        }
        .accessibilityIdentifier("removal-progress")
        if removal.phase != .saving {
          MuiButton(label: "Cancel", size: .sm) { removal.cancel() }
        }
      }
      if removal.phase == .failed || removal.phase == .closed {
        MuiButton(label: "Retry loading photo", size: .sm) { Task { await state.retryRendering() } }
      }
      if removal.modelFolderName == nil || showsModePicker {
        HStack {
          Text(removal.modelFolderName == nil ? "Local model required" : "LaMa model ready")
            .font(.caption).foregroundStyle(ProTokens.textMuted)
          Spacer(minLength: 4)
          MuiButton(
            label: "Import model", size: .sm, disabled: removal.busy || removal.phase == .review
          ) {
            selectingModels = true
          }
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
    .onChange(of: state.session.model) { _, _ in
      guard removal.active, !state.session.isSavingRemoval else { return }
      Task { await removal.open() }
    }
  }

  @ViewBuilder
  private var statusMessage: some View {
    if !removal.message.isEmpty || !importError.isEmpty {
      Text(importError.isEmpty ? removal.message : importError)
        .font(.caption).foregroundStyle(ProTokens.text)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("removal-status")
    }
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
  private var savedControls: some View {
    if !removal.savedRemovals.isEmpty {
      MuiCollapsible(label: "Saved removals", open: $showingSavedRemovals) {
        ForEach(removal.savedRemovals) { entry in
          VStack(alignment: .leading, spacing: 6) {
            Text("Removal \(entry.index + 1) · \(entry.active ? "Enabled" : "Disabled")")
              .font(.caption.weight(.semibold))
            if entry.needsReview {
              Text("Needs review: an earlier removal changed. Accepted pixels stay unchanged.")
                .font(.caption).accessibilityIdentifier("removal-needs-review")
            }
            HStack {
              MuiButton(
                label: "\(entry.active ? "Disable" : "Enable") removal \(entry.index + 1)",
                size: .sm,
                disabled: !entry.editable || removal.phase != .ready
                  || removal.replacingRemovalID != nil
              ) {
                Task { await removal.setSavedRemoval(entry.id, active: !entry.active) }
              }
              MuiButton(
                label: "Delete removal \(entry.index + 1)", size: .sm,
                disabled: removal.phase != .ready || removal.replacingRemovalID != nil
              ) {
                Task { await removal.setSavedRemoval(entry.id, active: nil) }
              }
            }
            MuiButton(
              label: "Replace removal \(entry.index + 1)", size: .sm,
              disabled: !entry.editable || removal.phase != .ready
                || removal.replacingRemovalID != nil
            ) {
              Task { await removal.replaceSavedRemoval(entry.id) }
            }
          }
        }
      }
    }
    if let id = removal.replacingRemovalID,
      let entry = removal.savedRemovals.first(where: { $0.id == id })
    {
      Text("Replacing removal \(entry.index + 1). Refine its selection, then Remove and Keep.")
        .font(.caption)
      MuiButton(label: "Cancel replacement", size: .sm, disabled: removal.busy) {
        Task { await removal.cancelSavedReplacement() }
      }
    }
  }

  @ViewBuilder
  private var selectionControls: some View {
    if removal.mode == .people {
      Text("People to remove").font(.caption.weight(.semibold))
      Text("Likely background people start selected. Subjects and uncertain people start kept.")
        .font(.caption)
      Text("Green = Keep · Red = Remove").font(.caption)
      if !removal.people.isEmpty {
        Text(
          "\(removal.people.count) people detected · \(removal.people.filter { !$0.keep }.count) marked Remove"
        )
        .font(.caption).accessibilityIdentifier("removal-people-count")
      }
      if !removal.people.isEmpty {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 4) {
            ForEach(removal.people) { person in
              VStack(alignment: .leading, spacing: 4) {
                HStack {
                  MuiCheckbox(
                    state: person.keep ? .unchecked : .checked,
                    label: "Person \(person.id) · \(person.role.label)", disabled: removal.busy
                  ) { removal.keepPerson(person.id) }
                  Spacer(minLength: 4)
                  if !person.keep {
                    MuiButton(
                      label: "Refine", size: .sm,
                      disabled: removal.busy
                        || (!removal.personChoicesNeedApply && !removal.canRefinePerson(person.id))
                    ) { Task { await removal.beginPersonRefinement(person.id) } }
                    .accessibilityLabel("Refine Person \(person.id)")
                  }
                }
                if let conflict = removal.personProtectionConflicts.first(where: {
                  $0.id == person.id
                }) {
                  Text(conflict.detail)
                    .font(.caption).foregroundStyle(ProTokens.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("removal-person-protection-\(person.id)")
                }
              }
            }
          }
        }
        .frame(
          height: min(
            CGFloat(removal.people.count) * 52
              + CGFloat(removal.personProtectionConflicts.count) * 64, 260)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("People to remove, multiple selection")
        .accessibilityIdentifier("removal-people-list")
      }
      if let id = removal.refiningPersonID {
        Text("Painting Person \(id): include missed edges, belongings, shadows or reflections.")
          .font(.caption)
        MuiButton(label: "Done refining", size: .sm, disabled: removal.busy) {
          removal.refinePerson(nil)
        }
      }
    }
    if removal.canPaint {
      if removal.mode == .smart {
        MuiButton(
          label: "Refine with Paint", size: .sm,
          disabled: removal.busy || removal.selection.isEmpty
        ) { removal.refineWithPaint() }
        .accessibilityIdentifier("removal-refine-with-paint")
      }
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
      Text("⌘Z Undo · ⇧⌘Z Redo")
        .font(.caption).foregroundStyle(ProTokens.textMuted)
    }
    MuiButton(
      label: "Clear selection", size: .sm,
      disabled: removal.busy
        || (removal.mode == .people
          ? removal.people.allSatisfy(\.keep) : removal.selection.isEmpty)
    ) {
      if removal.mode == .people {
        removal.clearSelectedPeople()
      } else {
        removal.clearSelection()
      }
    }
  }
}

extension RemovalSession.Mode {
  fileprivate var panelTitle: String {
    switch self {
    case .paint: "Paint"
    case .smart: "Auto Mask"
    case .people: "People"
    }
  }
}
