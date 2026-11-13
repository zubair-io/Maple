#if os(macOS)
  import SwiftUI

  /// Saved recipes and the durable export queue are app-wide, so they live in Settings (#5435).
  struct ExportRecipesSettingsSection: View {
    @State private var showsRecipes = false
    @State private var focusRequest = 0

    var body: some View {
      Section("Export") {
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Export recipes and queue")
            Text(
              "Save named recipes and resume or retry the saved export queue. Select photos in Browse to export them with a recipe."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
          NativeExportRecipesButton(focusRequest: focusRequest) { showsRecipes = true }
            .fixedSize()
        }
        .sheet(isPresented: $showsRecipes, onDismiss: refocusTrigger) {
          NativeExportRecipePanel()
        }
      }
    }

    private func refocusTrigger() { focusRequest += 1 }
  }
#endif
