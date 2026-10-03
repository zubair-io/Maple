import MapleCore
import SwiftUI

@MainActor
extension AppShell {
  func configureAgentBrowseAdapter() {
    agentBrowseAdapter.browseVM = browseVM
    agentBrowseAdapter.getSessions = { sessions }
    agentBrowseAdapter.ensureSessionHandler = { asset in
      ensureSession(for: asset)
      return sessions[asset.id] ?? EditSession(asset: asset)
    }
    agentBrowseAdapter.openPhotoHandler = { asset in
      openEditor(for: asset)
      mode = .editing
      let session = sessions[asset.id] ?? EditSession(asset: asset)
      AgentEditService.shared.activate(session)
      return session
    }
    AgentEditService.shared.browseDelegate = agentBrowseAdapter
  }
}
