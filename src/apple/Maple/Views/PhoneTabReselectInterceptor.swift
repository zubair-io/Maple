// PhoneTabReselectInterceptor.swift — tapping the selected tab without the
// pop to root (#5674). UIKit pops the stack natively before SwiftUI hears of
// the tap, so dropping SwiftUI's path write leaves the screen and the path out
// of sync on device; refusing the reselect in the delegate is the only fix.

#if os(iOS)
  import SwiftUI
  import UIKit

  struct PhoneTabReselectInterceptor: UIViewControllerRepresentable {
    /// Returns whether the reselect was handled; unhandled ones keep UIKit's pop.
    let onReselect: () -> Bool

    func makeUIViewController(context: Context) -> Host {
      Host(onReselect: onReselect)
    }

    func updateUIViewController(_ host: Host, context: Context) {
      host.proxy.onReselect = onReselect
      host.install()
    }

    final class Host: UIViewController {
      let proxy: ReselectProxy

      init(onReselect: @escaping () -> Bool) {
        proxy = ReselectProxy(onReselect: onReselect)
        super.init(nibName: nil, bundle: nil)
      }

      @available(*, unavailable)
      required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

      /// The tab bar holds its delegate weakly; hand SwiftUI's back before the
      /// proxy goes away so the tab bar never loses its delegate.
      isolated deinit {
        guard let tabBarController = installedOn, tabBarController.delegate === proxy else { return }
        tabBarController.delegate = proxy.wrapped
      }

      private weak var installedOn: UITabBarController?

      override func loadView() {
        view = UIView()
        view.isUserInteractionEnabled = false
      }

      override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        install()
      }

      /// SwiftUI may replace the delegate when it rebuilds the tabs, so this
      /// re-wraps whatever delegate is current on every update.
      func install() {
        guard let tabBarController, tabBarController.delegate !== proxy else { return }
        proxy.wrapped = tabBarController.delegate
        tabBarController.delegate = proxy
        installedOn = tabBarController
      }
    }

    final class ReselectProxy: NSObject, UITabBarControllerDelegate {
      var onReselect: () -> Bool
      weak var wrapped: UITabBarControllerDelegate?

      init(onReselect: @escaping () -> Bool) {
        self.onReselect = onReselect
      }

      func tabBarController(
        _ tabBarController: UITabBarController, shouldSelectTab tab: UITab
      ) -> Bool {
        guard tab !== tabBarController.selectedTab || !onReselect() else { return false }
        return wrapped?.tabBarController?(tabBarController, shouldSelectTab: tab) ?? true
      }

      func tabBarController(
        _ tabBarController: UITabBarController, shouldSelect viewController: UIViewController
      ) -> Bool {
        guard viewController !== tabBarController.selectedViewController || !onReselect() else {
          return false
        }
        return wrapped?.tabBarController?(tabBarController, shouldSelect: viewController) ?? true
      }

      override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (wrapped?.responds(to: selector) ?? false)
      }

      override func forwardingTarget(for selector: Selector!) -> Any? {
        wrapped?.responds(to: selector) == true ? wrapped : super.forwardingTarget(for: selector)
      }
    }
  }
#endif
