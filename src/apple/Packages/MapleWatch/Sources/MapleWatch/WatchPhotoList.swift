import MapleCloudKit
import SwiftUI

@MainActor
struct WatchPhotoList: View {
  let session: WatchSession
  let title: String
  @State private var model: WatchPhotoPage
  @State private var requestedPage = 0
  @State private var attempt = 0
  @State private var clearedAttempt = 0

  init(session: WatchSession, source: WatchPhotoPage.Source, title: String) {
    self.session = session
    self.title = title
    _model = State(
      initialValue: WatchPhotoPage(
        search: session.search, memories: session.memories, source: source))
  }

  var body: some View {
    List {
      if model.loading {
        ProgressView("Loading photos")
      } else if let error = model.error {
        Text(error)
        Button("Retry") { attempt += 1 }
      } else {
        if model.assets.isEmpty {
          Text(model.hasMore ? "No still photos on this page" : "No still photos")
        }
        ForEach(Array(model.assets.enumerated()), id: \.element.id) { index, asset in
          NavigationLink {
            WatchPhotoViewer(assets: model.assets, initialIndex: index, images: session.images)
          } label: {
            HStack {
              WatchRemoteImage(asset: asset, store: session.images, tier: .row)
                .id("\(asset.id)-\(attempt)")
                .frame(width: 44, height: 44)
                .accessibilityHidden(true)
              Text(asset.filename).lineLimit(2)
            }
          }
        }
        if model.page > 0 {
          Button("Previous page") { requestedPage = model.page - 1 }
        }
        if model.hasMore {
          Button("Next page") { requestedPage = model.page + 1 }
        }
        Button("Refresh") { attempt += 1 }
      }
    }
    .navigationTitle(title)
    .task(id: "\(requestedPage)-\(attempt)") {
      if attempt != clearedAttempt {
        await session.images.clear()
        guard !Task.isCancelled else { return }
        clearedAttempt = attempt
      }
      await model.load(page: requestedPage)
    }
  }
}

/// One decoded image is displayed at a time; Crown movement selects the next still.
@MainActor
struct WatchPhotoViewer: View {
  let assets: [SearchAsset]
  let images: WatchImageStore
  @State private var position: Double

  init(assets: [SearchAsset], initialIndex: Int, images: WatchImageStore) {
    self.assets = assets
    self.images = images
    _position = State(initialValue: Double(initialIndex))
  }

  private var index: Int { min(max(Int(position.rounded()), 0), assets.count - 1) }

  var body: some View {
    if !assets.isEmpty {
      VStack {
        WatchRemoteImage(asset: assets[index], store: images)
          .id(assets[index].id)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        Text("\(index + 1) of \(assets.count)").font(.caption2)
        HStack {
          Button("Previous", systemImage: "chevron.up") { position = Double(index - 1) }
            .disabled(index == 0)
          Button("Next", systemImage: "chevron.down") { position = Double(index + 1) }
            .disabled(index == assets.count - 1)
        }
        .labelStyle(.iconOnly)
      }
      .focusable()
      .digitalCrownRotation(
        $position, from: 0, through: Double(max(assets.count - 1, 1)), by: 1,
        sensitivity: .low, isContinuous: false, isHapticFeedbackEnabled: true
      )
      .navigationTitle("Photo")
    }
  }
}
