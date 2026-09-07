// PeoplePickerSheet+VM.swift — pure view-model helpers for PeoplePickerSheet.
//
// Co-located sibling per the `+VM.swift` pattern (issue #192): the sheet's
// load/create state machine is expressed as typed-in, typed-out functions so
// it is unit-testable without SwiftUI. This file MUST NOT `import SwiftUI`
// (CI greps for it); the view feeds these results into its `@State`.

import Foundation
import MapleCore

enum PeoplePickerVM {
    /// What the sheet shows once detection has finished.
    struct Loaded: Equatable {
        var people: [PersonCandidate]
        var selected: Int?
        var errorMessage: String?
    }

    /// Detection outcome → sheet state. "Nobody detected" is a normal state
    /// (the whole-image fallback), not an error; any other failure surfaces
    /// its localized description.
    static func loaded(_ result: Result<[PersonCandidate], Error>) -> Loaded {
        switch result {
        case .success(let people):
            return Loaded(people: people, selected: people.first?.id, errorMessage: nil)
        case .failure(PersonSkinMaskError.noPersonDetected):
            return Loaded(people: [], selected: nil, errorMessage: nil)
        case .failure(let error):
            return Loaded(
                people: [], selected: nil,
                errorMessage: "Couldn't detect people: \(error.localizedDescription)")
        }
    }

    /// The Create button is live once detection settled, no creation is in
    /// flight, and — when people were found — one of them is picked.
    static func canCreate(isLoading: Bool, isCreating: Bool, people: [PersonCandidate], selected: Int?) -> Bool {
        !isLoading && !isCreating && (people.isEmpty || selected != nil)
    }

    /// The person to segment, or `nil` for the whole-image skin fallback.
    static func creationTarget(people: [PersonCandidate], selected: Int?) -> PersonCandidate? {
        guard let selected else { return nil }
        return people.first { $0.id == selected }
    }

    static func creationErrorMessage(_ error: Error) -> String {
        "Couldn't create the mask: \(error.localizedDescription)"
    }
}
