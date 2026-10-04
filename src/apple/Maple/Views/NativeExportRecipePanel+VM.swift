#if os(macOS)
  import AppKit
  import Foundation
  import MapleCore
  import Observation
  import UniformTypeIdentifiers

  @MainActor
  @Observable
  final class NativeExportRecipePanelVM {
    typealias Resolver = @MainActor (AssetRef) async throws -> EditSession
    var recipe = ExportRecipe(destination: "directory", overwritePolicy: "error")
    var selectedRecipeID: UUID?
    var saved: [SavedNativeExportRecipe] = []
    var destination: URL?
    var destinationBookmark: Data?
    var bitDepthText = String(ExportRecipe.defaults.bitDepth)
    var qualityText = ExportRecipe.defaults.quality.map(String.init) ?? ""
    var longEdgeText = ""
    var error: String?
    var queueRecord: NativeExportRecord?
    var queueUnreadable = false
    var preparing = false
    var running = false
    private let queue = NativeExportQueue.shared
    private let store = NativeExportRecipeStore()
    private var generation = 0
    private var captureGeneration = 0
    private var recipeGeneration = 0
    private var preparation: Task<Void, Never>?

    var qualitySupported: Bool { supportsQuality(1) }
    var automaticQualitySupported: Bool { supportsQuality(nil) }
    private func supportsQuality(_ quality: UInt32?) -> Bool {
      guard let encoder = ExportRecipe.encoders.first(where: { $0.format == recipe.format })
      else { return false }
      let candidate = ExportRecipe(
        format: encoder.format, quality: quality, bitDepth: encoder.bitDepth)
      return (try? NativeExportRecipeBridge.validate(candidate)) != nil
    }

    private var inputError: String? {
      guard UInt32(bitDepthText) != nil,
        qualityText.isEmpty || UInt32(qualityText) != nil,
        longEdgeText.isEmpty || UInt32(longEdgeText) != nil
      else { return "Bit depth, quality and maximum long edge must be whole positive numbers." }
      return nil
    }
    var executionError: String? {
      if let inputError { return inputError }
      do {
        try NativeExportRecipeBridge.validate(recipe)
        return nil
      } catch { return error.localizedDescription }
    }

    func observe() async {
      generation &+= 1
      let current = generation
      do {
        let values = try await store.list()
        guard current == generation else { return }
        saved = values
      } catch {
        guard current == generation else { return }
        self.error = error.localizedDescription
      }
      do {
        let value = try await queue.load()
        guard current == generation else { return }
        queueRecord = value
        queueUnreadable = false
      } catch {
        guard current == generation else { return }
        self.error = error.localizedDescription
        queueUnreadable = true
      }
      let updates = await queue.updates()
      for await record in updates {
        guard !Task.isCancelled, current == generation else { return }
        queueRecord = record
        if record != nil { queueUnreadable = false }
        running = record?.phase == "running"
      }
    }

    func select(_ id: UUID?) {
      selectedRecipeID = id
      guard let entry = saved.first(where: { $0.id == id }) else { return }
      recipe = entry.recipe
      bitDepthText = String(recipe.bitDepth)
      qualityText = recipe.quality.map(String.init) ?? ""
      longEdgeText = recipe.maxLongEdge.map(String.init) ?? ""
      destinationBookmark = entry.destinationBookmark
      destination = nil
    }
    func changeFormat(_ format: String) {
      recipe.format = format
      if let encoder = ExportRecipe.encoders.first(where: { $0.format == format }) {
        recipe.bitDepth = encoder.bitDepth
        bitDepthText = String(recipe.bitDepth)
        recipe.quality =
          qualitySupported ? ExportRecipe.defaults.quality : nil
        qualityText = recipe.quality.map(String.init) ?? ""
      }
    }
    func setBitDepth(_ text: String) {
      bitDepthText = text
      if let value = UInt32(text) { recipe.bitDepth = value }
    }
    func setQuality(_ text: String) {
      qualityText = text
      if text.isEmpty || UInt32(text) != nil { recipe.quality = UInt32(text) }
    }
    func setLongEdge(_ text: String) {
      longEdgeText = text
      if text.isEmpty || UInt32(text) != nil { recipe.maxLongEdge = UInt32(text) }
    }
    func chooseDestination() {
      let panel = NSOpenPanel()
      panel.title = "Choose export destination"
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.canCreateDirectories = true
      guard panel.runModal() == .OK, let url = panel.url else { return }
      do {
        destinationBookmark = try url.bookmarkData(options: .withSecurityScope)
        destination = url
        recipe.directory = url.path
        recipe.destination = "directory"
        if recipe.overwritePolicy == "browser" { recipe.overwritePolicy = "error" }
        error = nil
      } catch { self.error = error.localizedDescription }
    }
    func save() {
      if let inputError {
        error = inputError
        return
      }
      let value = SavedNativeExportRecipe(
        id: selectedRecipeID ?? UUID(), recipe: recipe,
        destinationBookmark: destinationBookmark)
      recipeGeneration &+= 1
      let request = recipeGeneration
      Task {
        do {
          try await store.save(value)
          let values = try await store.list()
          guard request == recipeGeneration else { return }
          saved = values
          if recipe == value.recipe { selectedRecipeID = value.id }
          error = nil
        } catch {
          guard request == recipeGeneration else { return }
          self.error = error.localizedDescription
        }
      }
    }
    func delete() {
      guard let id = selectedRecipeID else { return }
      recipeGeneration &+= 1
      let request = recipeGeneration
      Task {
        do {
          try await store.delete(id)
          let values = try await store.list()
          guard request == recipeGeneration else { return }
          saved = values
          if selectedRecipeID == id { selectedRecipeID = nil }
        } catch {
          guard request == recipeGeneration else { return }
          self.error = error.localizedDescription
        }
      }
    }
    func importJSON() {
      let panel = NSOpenPanel()
      panel.allowedContentTypes = [.json]
      guard panel.runModal() == .OK, let url = panel.url else { return }
      do {
        recipe = try JSONDecoder().decode(ExportRecipe.self, from: Data(contentsOf: url))
        selectedRecipeID = nil
        destination = nil
        destinationBookmark = nil
        bitDepthText = String(recipe.bitDepth)
        qualityText = recipe.quality.map(String.init) ?? ""
        longEdgeText = recipe.maxLongEdge.map(String.init) ?? ""
        error = nil
      } catch { self.error = error.localizedDescription }
    }
    func exportJSON() {
      if let inputError {
        error = inputError
        return
      }
      let panel = NSSavePanel()
      panel.allowedContentTypes = [.json]
      panel.nameFieldStringValue = "export-recipe.json"
      guard panel.runModal() == .OK, let url = panel.url else { return }
      do {
        try Data(NativeExportRecipeBridge.json(recipe).utf8).write(to: url, options: .atomic)
      } catch { self.error = error.localizedDescription }
    }

    func enqueue(assets: [AssetRef], resolve: @escaping Resolver) {
      guard !preparing, !running else { return }
      if let executionError {
        error = executionError
        return
      }
      captureGeneration &+= 1
      let current = captureGeneration
      let chosen = recipe
      let grant = destinationBookmark
      let selected = destination
      preparing = true
      error = nil
      preparation = Task {
        do {
          let destination: URL
          if let selected {
            destination = selected
          } else if let grant {
            var stale = false
            destination = try URL(
              resolvingBookmarkData: grant, options: [.withSecurityScope, .withoutUI],
              bookmarkDataIsStale: &stale)
            guard !stale else {
              throw NativeExportError.message("Choose the destination folder again.")
            }
          } else {
            throw NativeExportError.message("Choose an export destination folder.")
          }
          var sessions: [EditSession] = []
          for asset in assets {
            try Task.checkCancellation()
            let session = try await resolve(asset)
            guard session.asset.id == asset.id else {
              throw NativeExportError.message("The selected photo changed.")
            }
            sessions.append(session)
          }
          let value = try await NativeExportCapture.record(
            sessions: sessions, recipe: chosen,
            destination: destination, workspace: queue.directory)
          try Task.checkCancellation()
          guard current == captureGeneration else { return }
          try await queue.enqueue(value)
          preparing = false
          queueRecord = value
          resume()
        } catch {
          guard current == captureGeneration else { return }
          preparing = false
          if !(error is CancellationError) { self.error = error.localizedDescription }
        }
      }
    }
    func cancel() {
      if preparing {
        preparation?.cancel()
        captureGeneration &+= 1
        preparing = false
      }
      Task { do { try await queue.cancel() } catch { self.error = error.localizedDescription } }
    }
    func resume() {
      guard !running else { return }
      running = true
      Task {
        do {
          try await queue.run()
          queueRecord = try await queue.load()
        } catch { self.error = error.localizedDescription }
        running = false
      }
    }
    func retry() {
      Task {
        do {
          try await queue.retryFailed()
          queueRecord = try await queue.load()
          resume()
        } catch { self.error = error.localizedDescription }
      }
    }
    func archiveSavedQueue() {
      Task {
        do {
          let archived = try await queue.archiveSavedQueue()
          queueRecord = nil
          queueUnreadable = false
          running = false
          error = archived.map {
            "Saved queue bytes were preserved at \($0.path). Outputs and originals were left intact. A new export can now be captured."
          }
        } catch { self.error = error.localizedDescription }
      }
    }
    func discardRemaining() {
      Task {
        do {
          try await queue.discardRemaining()
          queueRecord = try await queue.load()
        } catch { self.error = error.localizedDescription }
      }
    }
    func grantDestination() {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      guard panel.runModal() == .OK, let url = panel.url else { return }
      Task {
        do {
          try await queue.authorizeDestination(url)
          queueRecord = try await queue.load()
        } catch { self.error = error.localizedDescription }
      }
    }
    func grantSource(_ id: String) {
      let panel = NSOpenPanel()
      panel.title = "Choose the unchanged original photo"
      guard panel.runModal() == .OK, let url = panel.url else { return }
      Task {
        do {
          try await queue.authorizeSource(id: id, url: url)
          queueRecord = try await queue.load()
        } catch { self.error = error.localizedDescription }
      }
    }
  }
#endif
