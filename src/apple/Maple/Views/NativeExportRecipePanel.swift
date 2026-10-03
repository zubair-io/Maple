#if os(macOS)
  import MapleCore
  import MapleUI
  import SwiftUI

  struct NativeExportRecipePanel: View {
    let assets: [AssetRef]
    let resolve: NativeExportRecipePanelVM.Resolver
    @Environment(\.dismiss) private var dismiss
    @State private var vm = NativeExportRecipePanelVM()

    var body: some View {
      NavigationStack {
        Form {
          Section("Saved recipes") {
            Picker("Recipe", selection: Binding(get: { vm.selectedRecipeID }, set: vm.select)) {
              Text("Unsaved recipe").tag(nil as UUID?)
              ForEach(vm.saved) { value in Text(value.recipe.name).tag(Optional(value.id)) }
            }
            TextField("Recipe name", text: $vm.recipe.name)
            HStack {
              Button("Save", action: vm.save).accessibilityIdentifier("native-recipe-save")
              Button("Delete", action: vm.delete).disabled(vm.selectedRecipeID == nil)
              Button("Import JSON…", action: vm.importJSON)
              Button("Export JSON…", action: vm.exportJSON)
            }
          }
          NativeExportRecipeFields(vm: vm)
          Section("Destination") {
            Text(vm.destination?.path ?? vm.recipe.directory ?? "Choose a destination folder")
              .textSelection(.enabled)
            Button("Choose destination…", action: vm.chooseDestination)
              .accessibilityIdentifier("native-recipe-destination")
            choice("Delivery", value: $vm.recipe.destination, supported: ["directory"])
            choice(
              "Existing output", value: $vm.recipe.overwritePolicy,
              supported: ["error", "skip", "replace"])
            Text("Original photos are protected, including every photo in the initial selection.")
              .foregroundStyle(.secondary)
          }
          if let message = vm.executionError {
            Section("Recipe cannot run") { Text(message).foregroundStyle(.red) }
          }
          if let error = vm.error {
            Section("Export needs attention") {
              Text(error).foregroundStyle(.red).textSelection(.enabled)
            }
          }
          Section("Export selection") {
            Text(
              "\(assets.count) photos; captured edits and sequence numbers stay fixed during retry."
            )
            Button(vm.preparing ? "Capturing edits…" : "Add to queue") {
              vm.enqueue(assets: assets, resolve: resolve)
            }
            .disabled(assets.isEmpty || vm.preparing || vm.running || vm.executionError != nil)
            .accessibilityIdentifier("native-recipe-enqueue")
          }
          NativeExportQueueSection(vm: vm)
        }
        .formStyle(.grouped)
        .navigationTitle("Export recipes and queue")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }.accessibilityIdentifier("native-recipe-close")
          }
        }
      }
      .frame(minWidth: 620, minHeight: 620)
      .task { await vm.observe() }
    }

    @ViewBuilder
    private func choice(_ name: String, value: Binding<String>, supported: [String]) -> some View {
      Picker(name, selection: value) {
        ForEach(
          supported + (supported.contains(value.wrappedValue) ? [] : [value.wrappedValue]),
          id: \.self
        ) {
          Text($0).tag($0)
        }
      }
    }
  }

  private struct NativeExportRecipeFields: View {
    @Bindable var vm: NativeExportRecipePanelVM
    var body: some View {
      Section("Output") {
        Picker("Format", selection: Binding(get: { vm.recipe.format }, set: vm.changeFormat)) {
          ForEach(
            ExportRecipe.encoders.map(\.format)
              + (ExportRecipe.encoders.contains(where: { $0.format == vm.recipe.format })
                ? [] : [vm.recipe.format]),
            id: \.self
          ) {
            Text($0.uppercased()).tag($0)
          }
        }
        .accessibilityIdentifier("native-recipe-format")
        TextField("Bit depth", text: Binding(get: { vm.bitDepthText }, set: vm.setBitDepth))
        TextField(
          "Quality (1–100; empty for lossless)",
          text: Binding(get: { vm.qualityText }, set: vm.setQuality))
        TextField(
          "Maximum long edge (pixels; empty for full size)",
          text: Binding(get: { vm.longEdgeText }, set: vm.setLongEdge))
        Text("Smaller photos are never enlarged.").foregroundStyle(.secondary)
        choice(
          "Output profile", value: $vm.recipe.outputProfile, supported: ExportRecipe.outputProfiles)
        choice(
          "Rendering intent", value: $vm.recipe.renderingIntent,
          supported: ExportRecipe.renderingIntents)
        choice(
          "Metadata", value: $vm.recipe.metadataPolicy, supported: ExportRecipe.metadataPolicies)
        TextField("Naming template", text: $vm.recipe.namingTemplate)
          .accessibilityIdentifier("native-recipe-naming")
        Text("Use {original}, {ext}, {n}, or {date:FORMAT}.").foregroundStyle(.secondary)
        TextField(
          "Watermark (unsupported; leave empty)",
          text: Binding(
            get: { vm.recipe.watermark ?? "" }, set: { vm.recipe.watermark = $0.isEmpty ? nil : $0 }
          ))
        Text("HEIC remains available in the single photo Export panel.").foregroundStyle(.secondary)
      }
    }
    private func choice(_ name: String, value: Binding<String>, supported: [String]) -> some View {
      Picker(name, selection: value) {
        ForEach(
          supported + (supported.contains(value.wrappedValue) ? [] : [value.wrappedValue]),
          id: \.self
        ) {
          Text($0).tag($0)
        }
      }
    }
  }

  private struct NativeExportQueueSection: View {
    @Bindable var vm: NativeExportRecipePanelVM
    var body: some View {
      Section("Saved export queue") {
        if let record = vm.queueRecord {
          Text("\(record.recipe.name): \(record.phase)")
          ProgressView(value: Double(record.processed), total: Double(record.items.count))
            .accessibilityLabel("Export progress")
            .accessibilityIdentifier("native-export-progress")
          Text(
            "\(record.successes) exported, \(record.failures) failed, \(record.remaining) remaining"
          )
          HStack {
            Button("Resume remaining", action: vm.resume)
              .disabled(vm.running || vm.preparing || record.remaining == 0)
              .accessibilityIdentifier("native-export-resume")
            Button("Retry failed", action: vm.retry)
              .disabled(vm.running || vm.preparing || record.remaining > 0 || record.failures == 0)
              .accessibilityIdentifier("native-export-retry")
            Button("Cancel export", action: vm.cancel)
              .disabled(!vm.running && !vm.preparing && record.remaining == 0)
              .accessibilityIdentifier("native-export-cancel")
          }
          Button("Grant destination access again…", action: vm.grantDestination).disabled(
            vm.running)
          ForEach(record.items) { item in
            VStack(alignment: .leading) {
              Text("\(item.target.stem): \(item.status)")
              if let staging = item.staging, item.status == "failed" {
                Text("Staging path: \(staging.path)").font(.caption).textSelection(.enabled)
              }
              if let reason = item.reason {
                Text(reason).foregroundStyle(.red).textSelection(.enabled)
              }
            }
          }
          DisclosureGroup("Original access grants") {
            ForEach(record.originals, id: \.id) { source in
              Button("Choose unchanged original: \(source.url.lastPathComponent)…") {
                vm.grantSource(source.id)
              }
              .disabled(vm.running)
            }
          }
          Text("Closing this panel keeps the queue running. After relaunch, resume is explicit.")
            .foregroundStyle(.secondary)
        } else {
          Text(vm.queueUnreadable ? "No readable saved export queue." : "No saved export queue.")
            .foregroundStyle(.secondary)
          if vm.queueUnreadable {
            Button("Archive unreadable saved queue…", action: vm.archiveSavedQueue)
              .disabled(vm.running || vm.preparing)
          }
        }
      }
    }
  }
#endif
