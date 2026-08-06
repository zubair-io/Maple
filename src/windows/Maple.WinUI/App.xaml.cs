using System;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Maple.WinUI.Native;

namespace Maple.WinUI
{
    public partial class App : Application
    {
        private static Window? _window;

        /// <summary>UI-thread dispatcher, captured at launch so background
        /// render/decode threads can marshal results back.</summary>
        public static DispatcherQueue? MainDispatcherQueue { get; private set; }

        /// <summary>Protocol activation entry (maple-app://auth-success?...):
        /// invoked by Program for both the cold-start activation and redirected
        /// activations from second instances. Routes the sign-in callback to
        /// the main window on the UI thread.</summary>
        public static void OnRedirectedActivation(Microsoft.Windows.AppLifecycle.AppActivationArguments args)
        {
            // Registered protocol activations arrive as Protocol; a raw
            // registry registration (or some shells) delivers the URI as a
            // plain Launch argument instead — accept both.
            Uri? uri = null;
            if (args.Kind == Microsoft.Windows.AppLifecycle.ExtendedActivationKind.Protocol
                && args.Data is Windows.ApplicationModel.Activation.IProtocolActivatedEventArgs protocol)
            {
                uri = protocol.Uri;
            }
            else if (args.Kind == Microsoft.Windows.AppLifecycle.ExtendedActivationKind.Launch
                && args.Data is Windows.ApplicationModel.Activation.ILaunchActivatedEventArgs launch)
            {
                var arg = launch.Arguments?.Trim().Trim('"');
                if (arg != null && arg.StartsWith("maple-app://", StringComparison.OrdinalIgnoreCase)
                    && Uri.TryCreate(arg, UriKind.Absolute, out var parsed))
                {
                    uri = parsed;
                }
            }
            if (uri == null)
                return;
            Maple.WinUI.Services.DiagLog.Write($"[auth] callback activation: {uri.Scheme}://{uri.Host}");
            var captured = uri;
            MainDispatcherQueue?.TryEnqueue(() =>
                (_window as MainWindow)?.HandleAuthCallback(captured));
        }

        public App()
        {
            this.InitializeComponent();
            this.UnhandledException += (_, e) =>
            {
                Maple.WinUI.Services.DiagLog.Write($"[crash] {e.Exception}");
                e.Handled = false;
            };
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                Maple.WinUI.Services.DiagLog.Write($"[crash-domain] {e.ExceptionObject}");
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            RawFfi.VerifyAbi();
            Controls.ToneCurveMath.VerifyParity();
            Maple.WinUI.Services.ProtocolRegistrar.EnsureRegistered();
            MainDispatcherQueue = DispatcherQueue.GetForCurrentThread();
            _window = new MainWindow();
            _window.Activate();
        }
    }
}
