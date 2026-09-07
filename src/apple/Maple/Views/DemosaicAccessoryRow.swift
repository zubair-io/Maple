// DemosaicAccessoryRow.swift — Detail-group accessory for the S5 editor
// (#3413).
//
// The Bayer demosaic kernel override. Like the Profile picker in
// `ColorAccessoryRow`, this is a discrete choice rather than a value to
// drag, so it does not fit the tool-pill model and surfaces instead as a
// thin contextual strip above the Detail group's slider grid — shown only
// while the Detail group is armed. Web's `DemosaicPanelComponent` is the
// structural twin, in the same position (Detail → Basic, above the
// sliders).
//
// `demosaic` is a DECODE-PRODUCT field: choosing a kernel re-runs the Rust
// decode rather than a per-tick GPU stage (`EditTransaction.decodeInputs`
// carries it). So the write takes its own undo entry through
// `commit` / `endEdit`, the shape `EditorState.setBlackWhite` uses for the
// other discrete Detail/Colour actions, rather than the drag-bar value
// pipe — there is no continuous gesture to coalesce.
//
// Mounted in both editors, exactly as `ColorAccessoryRow` is: above the
// Detail group's slider stack in `StackedAdjustmentsPanel` (the shared
// iPad/Mac inspector) and in `IPhoneControlBar`'s contextual controls.
// Lives in its own file so both stay thin composers, the same reason
// `ColorAccessoryRow` and `ProfilePicker` do.

import MapleCore
import SwiftUI

struct DemosaicAccessoryRow: View {
  @Bindable var state: EditorState

  private var session: EditSession { state.session }

  /// Menu label per kernel. Names what the option DOES rather than the
  /// algorithm's initials — nobody outside the pipeline knows what RCD
  /// stands for — with the algorithm name kept in parentheses so a user
  /// comparing against another raw developer can still find it.
  private static func label(_ choice: DemosaicChoice) -> String {
    switch choice {
    case .auto: return "Automatic"
    case .dualAmaze: return "Detail + smooth (AMaZE / VNG4)"
    case .dualRcd: return "Detail + smooth, faster (RCD / VNG4)"
    case .amaze: return "Maximum detail (AMaZE)"
    case .rcd: return "Balanced (RCD)"
    case .lmmse: return "High ISO (LMMSE)"
    }
  }

  /// Ordered by how a photographer reaches for them: the automatic answer
  /// first, then the two duals that are usually its verdict, then the
  /// single kernels.
  private static let order: [DemosaicChoice] = [
    .auto, .dualAmaze, .dualRcd, .amaze, .rcd, .lmmse,
  ]

  /// Hand-built binding for the same reason `ColorAccessoryRow`'s is:
  /// `EditorState.session` is a `let` reference, so a key-path projection
  /// through it will not form. The setter takes an undo snapshot before
  /// the model moves, matching every other discrete editor action.
  private var binding: Binding<DemosaicChoice> {
    Binding(
      get: { session.model.demosaic },
      set: { choice in
        guard choice != session.model.demosaic else { return }
        state.commit(description: "Demosaic")
        defer { session.endEdit() }
        session.model.demosaic = choice
      }
    )
  }

  var body: some View {
    HStack(spacing: 6) {
      Text("Demosaic")
        .font(.system(size: 11, weight: .regular))
        .foregroundStyle(MapleTokens.textMuted)
      Picker("Demosaic", selection: binding) {
        ForEach(Self.order, id: \.self) { choice in
          Text(Self.label(choice)).tag(choice)
        }
      }
      .labelsHidden()
      .pickerStyle(.menu)
      .fixedSize()
      .accessibilityIdentifier("picker-demosaic")
      .accessibilityLabel("Demosaic kernel")
      Spacer(minLength: 0)
    }
    .padding(.bottom, 2)
  }
}
