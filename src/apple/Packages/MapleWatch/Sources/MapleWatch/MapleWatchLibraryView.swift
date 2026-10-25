import MapleCloudKit
import SwiftUI

/// Authenticated browsing entry point. Destroy this view on sign-out to release its session cache.
@MainActor
public struct MapleWatchLibraryView: View {
  @State private var session: WatchSession
  @State private var libraries: [CloudFolder] = []
  @State private var error: String?
  @State private var loading = true
  @State private var attempt = 0
  @State private var generation = 0
  private let onSignOut: () -> Void

  public init(server: URL, onSignOut: @escaping () -> Void) {
    self.onSignOut = onSignOut
    _session = State(initialValue: WatchSession(server: server, onSignOut: onSignOut))
  }

  public var body: some View {
    NavigationStack {
      List {
        if loading {
          ProgressView("Loading libraries")
        } else if let error {
          Text(error)
          Button("Retry") { attempt += 1 }
        } else if libraries.isEmpty {
          Text("No libraries yet. Add a library to your Maple server.")
          Button("Refresh") { attempt += 1 }
        } else {
          ForEach(libraries) { library in
            NavigationLink {
              List {
                NavigationLink("Recent Photos") {
                  WatchPhotoList(
                    session: session, source: .recent(library.id), title: "Recent Photos")
                }
                NavigationLink("Memories") {
                  WatchMemoriesView(session: session, libraryID: library.id)
                }
              }
              .navigationTitle(library.displayName)
            } label: {
              VStack(alignment: .leading) {
                Text(library.displayName)
                if !library.isConnected { Text("Source offline").font(.caption2) }
              }
            }
          }
          Button("Refresh libraries") { attempt += 1 }
        }
        Button("Disconnect", role: .destructive) {
          session.disconnect()
          onSignOut()
        }
      }
      .navigationTitle("Maple")
      .task(id: attempt) { await load() }
    }
  }

  private func load() async {
    generation += 1
    let current = generation
    loading = true
    error = nil
    do {
      let result = try await session.folders.listFolders()
      guard current == generation, !Task.isCancelled else { return }
      libraries = result
      loading = false
    } catch {
      guard current == generation, !Task.isCancelled else { return }
      self.error = error.localizedDescription
      loading = false
    }
  }
}

@MainActor
struct WatchMemoriesView: View {
  let session: WatchSession
  let libraryID: String
  @State private var memories: [GeneratedSearchCard] = []
  @State private var loading = true
  @State private var error: String?
  @State private var attempt = 0
  @State private var generation = 0

  var body: some View {
    List {
      if loading {
        ProgressView("Loading memories")
      } else if let error {
        Text(error)
      } else if memories.isEmpty {
        Text("No memories yet")
      } else {
        ForEach(memories) { memory in
          NavigationLink {
            WatchPhotoList(session: session, source: .memory(memory.id), title: memory.title)
          } label: {
            VStack(alignment: .leading) {
              Text(memory.title)
              if let subtitle = memory.subtitle { Text(subtitle).font(.caption2) }
            }
          }
        }
      }
      Button(error == nil ? "Refresh" : "Retry") { attempt += 1 }
        .disabled(loading)
    }
    .navigationTitle("Memories")
    .task(id: attempt) {
      generation += 1
      let current = generation
      loading = true
      error = nil
      do {
        let result = try await session.memories.collections(libraryID: libraryID)
        guard current == generation, !Task.isCancelled else { return }
        memories = result
        loading = false
      } catch {
        guard current == generation, !Task.isCancelled else { return }
        self.error = error.localizedDescription
        loading = false
      }
    }
  }
}
