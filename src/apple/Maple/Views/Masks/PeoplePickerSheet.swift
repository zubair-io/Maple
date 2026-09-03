// PeoplePickerSheet.swift — "Add a skin mask" flow (#3275, spec §3.2). Runs
// Vision person detection when it opens; the user picks a person (or falls
// back to the whole-image skin range when nobody was detected).

import MapleCore
import SwiftUI

struct PeoplePickerSheet: View {
    @Bindable var state: EditorState
    @Environment(\.dismiss) private var dismiss

    @State private var people: [PersonCandidate] = []
    @State private var selected: Int?
    @State private var facialSkin = true
    @State private var bodySkin = true
    @State private var isLoading = true
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add Skin Mask")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create") { Task { await create() } }
                            .disabled(isCreating || isLoading || (!people.isEmpty && selected == nil))
                    }
                }
        }
        .task { await load() }
    }

    @ViewBuilder private var content: some View {
        if isLoading {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage {
            Text(errorMessage).foregroundStyle(.secondary).padding()
        } else if people.isEmpty {
            VStack(spacing: 12) {
                Text("No person detected").font(.headline)
                Text("Create a skin-tone mask from the whole image instead.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Form {
                Section("Person") {
                    Picker("Person", selection: $selected) {
                        ForEach(people) { p in Text("Person \(p.id + 1)").tag(Optional(p.id)) }
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    Toggle("Facial skin", isOn: $facialSkin)
                    Toggle("Body skin", isOn: $bodySkin)
                }
            }
        }
    }

    private func load() async {
        do {
            people = try await state.session.detectMaskPersons()
            selected = people.first?.id
        } catch PersonSkinMaskError.noPersonDetected {
            people = []
        } catch {
            errorMessage = "Couldn't detect people: \(error.localizedDescription)"
        }
        isLoading = false
    }

    private func create() async {
        isCreating = true
        do {
            if let selected, let person = people.first(where: { $0.id == selected }) {
                try await state.session.createPersonSkinMask(person: person, facialSkin: facialSkin, bodySkin: bodySkin)
            } else {
                state.session.createWholeImageSkinMask()
            }
            dismiss()
        } catch {
            errorMessage = "Couldn't create the mask: \(error.localizedDescription)"
            isCreating = false
        }
    }
}
