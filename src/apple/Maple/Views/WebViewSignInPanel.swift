// WebViewSignInPanel.swift
//
// Hosts a WKWebView inside a SwiftUI sheet panel. Loads the Maple Cloud
// server's sign-in URL and listens for an `auth_success` message posted
// by the web app's AuthService via `window.webkit.messageHandlers.maple`.
//
// Why not native passkeys? Native ASAuthorizationController requires the
// app to have an Associated Domains entitlement listing every domain it
// can authenticate against, which is fundamentally incompatible with a
// multi-tenant / self-hosted product where each customer brings their
// own domain. WebAuthn inside a webview verifies against the page's
// origin as the rpId, no entitlement needed.

import SwiftUI
import WebKit
import MapleCore

#if os(macOS)
import AppKit
typealias PlatformViewRepresentable = NSViewRepresentable
#else
import UIKit
typealias PlatformViewRepresentable = UIViewRepresentable
#endif

/// Bridge messages posted from the web app's `AuthService` via
/// `window.webkit.messageHandlers.maple.postMessage(...)`.
private struct AuthSuccessMessage: Decodable {
  let type: String
  let access_token: String
  let refresh_token: String
  let user: AuthUser
}

/// Carries closures into the WKWebView wrapper. Reference type so the
/// `WKScriptMessageHandler` can call back into the view model after the
/// SwiftUI body returns. Closures are nilable because the wrapper may
/// outlive the panel briefly during teardown.
@MainActor
final class WebViewBridge: NSObject, WKScriptMessageHandler {
  var onAuthSuccess: ((String, String, AuthUser) -> Void)?
  var onLoadFailure: ((String) -> Void)?

  nonisolated func userContentController(_ userContentController: WKUserContentController,
                                         didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any],
          let type = body["type"] as? String,
          type == "auth_success",
          let access = body["access_token"] as? String,
          let refresh = body["refresh_token"] as? String,
          let userDict = body["user"] as? [String: Any],
          let id = userDict["id"] as? String,
          let email = userDict["email"] as? String,
          let role = userDict["role"] as? String
    else { return }
    let user = AuthUser(id: id, email: email, role: role)
    Task { @MainActor in
      self.onAuthSuccess?(access, refresh, user)
    }
  }
}

struct WebViewSignInPanel: View {
  let host: CloudHost
  let onAuthSuccess: (String, String, AuthUser) -> Void
  let onLoadFailure: (String) -> Void

  var body: some View {
    WebViewWrapper(host: host,
                   onAuthSuccess: onAuthSuccess,
                   onLoadFailure: onLoadFailure)
      .frame(minWidth: 480, minHeight: 560)
  }
}

/// Cross-platform WKWebView host. Configured with the `maple` script
/// message handler that the web app's `AuthService.postNativeAuthSuccess`
/// posts to.
private struct WebViewWrapper: PlatformViewRepresentable {
  let host: CloudHost
  let onAuthSuccess: (String, String, AuthUser) -> Void
  let onLoadFailure: (String) -> Void

  func makeCoordinator() -> WebViewBridge {
    let bridge = WebViewBridge()
    bridge.onAuthSuccess = onAuthSuccess
    bridge.onLoadFailure = onLoadFailure
    return bridge
  }

  #if os(macOS)
  func makeNSView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
  func updateNSView(_ webView: WKWebView, context: Context) {}
  #else
  func makeUIView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
  func updateUIView(_ webView: WKWebView, context: Context) {}
  #endif

  @MainActor
  private func makeWebView(coordinator: WebViewBridge) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.userContentController.add(coordinator, name: "maple")

    // Use a non-persistent data store so the webview's cookies don't
    // bleed across sheet presentations or pollute the user's Safari.
    // The refresh token comes back in the JSON body, captured by the
    // bridge, so we don't need cookie persistence.
    config.websiteDataStore = .nonPersistent()

    let webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = NavDelegateBox.shared
    NavDelegateBox.shared.onLoadFailure = onLoadFailure

    // Load the root — the SPA's router will route an unauthenticated
    // visit to /sign-in (or /join if the user has an invite). The web
    // app detects native shell via `window.webkit.messageHandlers.maple`
    // and skips its own post-login navigation.
    var req = URLRequest(url: host.url)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    webView.load(req)
    return webView
  }
}

/// One global navigation delegate so we don't have to wire it through
/// SwiftUI's coordinator (which conflates with the script handler).
@MainActor
private final class NavDelegateBox: NSObject, WKNavigationDelegate {
  static let shared = NavDelegateBox()
  var onLoadFailure: ((String) -> Void)?

  nonisolated func webView(_ webView: WKWebView,
                           didFail navigation: WKNavigation!,
                           withError error: Error) {
    let msg = error.localizedDescription
    Task { @MainActor in self.onLoadFailure?(msg) }
  }

  nonisolated func webView(_ webView: WKWebView,
                           didFailProvisionalNavigation navigation: WKNavigation!,
                           withError error: Error) {
    let msg = error.localizedDescription
    Task { @MainActor in self.onLoadFailure?(msg) }
  }
}
